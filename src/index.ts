/**
 * Moltbot + Cloudflare Sandbox
 *
 * This Worker runs Moltbot personal AI assistant in a Cloudflare Sandbox container.
 * It proxies all requests to the Moltbot Gateway's web UI and WebSocket endpoint.
 *
 * Features:
 * - Web UI (Control Dashboard + WebChat) at /
 * - WebSocket support for real-time communication
 * - Admin UI at /_admin/ for device management
 * - Configuration via environment secrets
 *
 * Required secrets (set via `wrangler secret put`):
 * - ANTHROPIC_API_KEY: Your Anthropic API key
 *
 * Optional secrets:
 * - MOLTBOT_GATEWAY_TOKEN: Token to protect gateway access
 * - TELEGRAM_BOT_TOKEN: Telegram bot token
 * - DISCORD_BOT_TOKEN: Discord bot token
 * - SLACK_BOT_TOKEN + SLACK_APP_TOKEN: Slack tokens
 */

import { Hono } from 'hono';
import { getSandbox, Sandbox, type SandboxOptions } from '@cloudflare/sandbox';

import type { AppEnv, MoltbotEnv } from './types';
import { MOLTBOT_PORT } from './config';
import { createAccessMiddleware } from './auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess } from './gateway';
import { publicRoutes, api, adminUi, debug, cdp } from './routes';
import { redactSensitiveParams } from './utils/logging';
import { braveWebSearch, duckDuckGoSearch, formatSearchResultsAsContext } from './utils/brave-search';
import loadingPageHtml from './assets/loading.html';
import configErrorHtml from './assets/config-error.html';

/**
 * Transform error messages from the gateway to be more user-friendly.
 */
function transformErrorMessage(message: string, host: string): string {
  if (message.includes('gateway token missing') || message.includes('gateway token mismatch')) {
    return `Invalid or missing token. Visit https://${host}?token={REPLACE_WITH_YOUR_TOKEN}`;
  }

  if (message.includes('pairing required')) {
    return `Pairing required. Visit https://${host}/_admin/`;
  }

  return message;
}

/**
 * Check if a parsed WebSocket message is an internal/tool message that should not be forwarded to the client.
 * Returns true if the message should be filtered out.
 */
function isInternalMessage(parsed: Record<string, unknown>): boolean {
  // Direct tool_use / function type messages
  if (parsed.type === 'tool_use' || parsed.type === 'tool_result' || parsed.type === 'function') {
    return true;
  }

  // Streaming delta messages for tool input
  if (parsed.type === 'content_block_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'input_json_delta' || delta?.type === 'tool_use') {
      return true;
    }
  }

  // Content block start for tool_use
  if (parsed.type === 'content_block_start') {
    const block = parsed.content_block as Record<string, unknown> | undefined;
    if (block?.type === 'tool_use') {
      return true;
    }
  }

  // Messages where stop_reason is tool_use (intermediate step, not final answer)
  if (parsed.stop_reason === 'tool_use') {
    return true;
  }

  // Messages with role=assistant where ALL content blocks are tool calls
  if (Array.isArray(parsed.content) && parsed.content.length > 0) {
    const allToolCalls = parsed.content.every(
      (b: { type: string }) => b.type === 'tool_use' || b.type === 'function' || b.type === 'tool_result',
    );
    if (allToolCalls) {
      return true;
    }
  }

  // OpenAI-format tool_calls array
  if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0 && !parsed.content) {
    return true;
  }

  return false;
}

/**
 * For messages with mixed content (text + tool_use), strip the tool blocks and return only text.
 * Returns the cleaned message string, or null if no text content remains.
 */
function stripToolBlocksFromContent(parsed: Record<string, unknown>): string | null {
  if (!Array.isArray(parsed.content) || parsed.content.length === 0) {
    return null;
  }

  const hasTextBlock = parsed.content.some((b: { type: string }) => b.type === 'text');
  const hasToolBlock = parsed.content.some(
    (b: { type: string }) => b.type === 'tool_use' || b.type === 'function',
  );

  if (hasTextBlock && hasToolBlock) {
    // Strip tool blocks, keep only text
    const textOnly = parsed.content.filter((b: { type: string }) => b.type === 'text');
    const cleaned: Record<string, unknown> = { ...parsed, content: textOnly };
    // Remove stop_reason if it was tool_use
    if (cleaned.stop_reason === 'tool_use') {
      cleaned.stop_reason = 'end_turn';
    }
    return JSON.stringify(cleaned);
  }

  return null;
}

export { Sandbox };

/**
 * Validate required environment variables.
 * Returns an array of missing variable descriptions, or empty array if all are set.
 */
function validateRequiredEnv(env: MoltbotEnv): string[] {
  const missing: string[] = [];
  const isTestMode = env.DEV_MODE === 'true' || env.E2E_TEST_MODE === 'true';

  if (!env.MOLTBOT_GATEWAY_TOKEN) {
    missing.push('MOLTBOT_GATEWAY_TOKEN');
  }

  // CF Access vars not required in dev/test mode since auth is skipped
  if (!isTestMode) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      missing.push('CF_ACCESS_TEAM_DOMAIN');
    }

    if (!env.CF_ACCESS_AUD) {
      missing.push('CF_ACCESS_AUD');
    }
  }

  // Check for AI provider configuration (at least one must be set)
  const hasCloudflareGateway = !!(
    env.CLOUDFLARE_AI_GATEWAY_API_KEY &&
    env.CF_AI_GATEWAY_ACCOUNT_ID &&
    env.CF_AI_GATEWAY_GATEWAY_ID
  );
  const hasLegacyGateway = !!(env.AI_GATEWAY_API_KEY && env.AI_GATEWAY_BASE_URL);
  const hasAnthropicKey = !!env.ANTHROPIC_API_KEY;
  const hasOpenAIKey = !!env.OPENAI_API_KEY;
  if (!hasCloudflareGateway && !hasLegacyGateway && !hasAnthropicKey && !hasOpenAIKey) {
    missing.push(
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, or CLOUDFLARE_AI_GATEWAY_API_KEY + CF_AI_GATEWAY_ACCOUNT_ID + CF_AI_GATEWAY_GATEWAY_ID',
    );
  }

  return missing;
}

/**
 * Build sandbox options based on environment configuration.
 *
 * SANDBOX_SLEEP_AFTER controls how long the container stays alive after inactivity:
 * - 'never' (default): Container stays alive indefinitely (recommended due to long cold starts)
 * - Duration string: e.g., '10m', '1h', '30s' - container sleeps after this period of inactivity
 *
 * To reduce costs at the expense of cold start latency, set SANDBOX_SLEEP_AFTER to a duration:
 *   npx wrangler secret put SANDBOX_SLEEP_AFTER
 *   # Enter: 10m (or 1h, 30m, etc.)
 */
function buildSandboxOptions(env: MoltbotEnv): SandboxOptions {
  const sleepAfter = env.SANDBOX_SLEEP_AFTER?.toLowerCase() || 'never';

  // 'never' means keep the container alive indefinitely
  if (sleepAfter === 'never') {
    return { keepAlive: true };
  }

  // Otherwise, use the specified duration
  return { sleepAfter };
}

// Main app
const app = new Hono<AppEnv>();

// =============================================================================
// MIDDLEWARE: Applied to ALL routes
// =============================================================================

// Middleware: Log every request (concise)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const redactedSearch = redactSensitiveParams(url);
  console.log(`[REQ] ${c.req.method} ${url.pathname}${redactedSearch}`);
  await next();
});

// Middleware: Initialize sandbox for all requests
app.use('*', async (c, next) => {
  const options = buildSandboxOptions(c.env);
  const sandbox = getSandbox(c.env.Sandbox, 'moltbot', options);
  c.set('sandbox', sandbox);
  await next();
});

// =============================================================================
// PUBLIC ROUTES: No Cloudflare Access authentication required
// =============================================================================

// Mount public routes first (before auth middleware)
// Includes: /sandbox-health, /logo.png, /logo-small.png, /api/status, /_admin/assets/*
app.route('/', publicRoutes);

// Mount CDP routes (uses shared secret auth via query param, not CF Access)
app.route('/cdp', cdp);

// =============================================================================
// PROTECTED ROUTES: Cloudflare Access authentication required
// =============================================================================

// Middleware: Validate required environment variables (skip in dev mode and for debug routes)
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);

  // Skip validation for debug routes (they have their own enable check)
  if (url.pathname.startsWith('/debug')) {
    return next();
  }

  // Skip validation in dev mode
  if (c.env.DEV_MODE === 'true') {
    return next();
  }

  const missingVars = validateRequiredEnv(c.env);
  if (missingVars.length > 0) {
    console.error('[CONFIG] Missing required environment variables:', missingVars.join(', '));

    const acceptsHtml = c.req.header('Accept')?.includes('text/html');
    if (acceptsHtml) {
      // Return a user-friendly HTML error page
      const html = configErrorHtml.replace('{{MISSING_VARS}}', missingVars.join(', '));
      return c.html(html, 503);
    }

    // Return JSON error for API requests
    return c.json(
      {
        error: 'Configuration error',
        message: 'Required environment variables are not configured',
        missing: missingVars,
        hint: 'Set these using: wrangler secret put <VARIABLE_NAME>',
      },
      503,
    );
  }

  return next();
});

// Middleware: Cloudflare Access authentication for protected routes
app.use('*', async (c, next) => {
  // Determine response type based on Accept header
  const acceptsHtml = c.req.header('Accept')?.includes('text/html');
  const middleware = createAccessMiddleware({
    type: acceptsHtml ? 'html' : 'json',
    redirectOnMissing: acceptsHtml,
  });

  return middleware(c, next);
});

// Mount API routes (protected by Cloudflare Access)
app.route('/api', api);

// Mount Admin UI routes (protected by Cloudflare Access)
app.route('/_admin', adminUi);

// Mount debug routes (protected by Cloudflare Access, only when DEBUG_ROUTES is enabled)
app.use('/debug/*', async (c, next) => {
  if (c.env.DEBUG_ROUTES !== 'true') {
    return c.json({ error: 'Debug routes are disabled' }, 404);
  }
  return next();
});
app.route('/debug', debug);

// =============================================================================
// CATCH-ALL: Proxy to Moltbot gateway
// =============================================================================

app.all('*', async (c) => {
  const sandbox = c.get('sandbox');
  const request = c.req.raw;
  const url = new URL(request.url);

  console.log('[PROXY] Handling request:', url.pathname);

  // Check if gateway is already running
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  const isGatewayReady = existingProcess !== null && existingProcess.status === 'running';

  // For browser requests (non-WebSocket, non-API), show loading page if gateway isn't ready
  const isWebSocketRequest = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const acceptsHtml = request.headers.get('Accept')?.includes('text/html');

  if (!isGatewayReady && !isWebSocketRequest && acceptsHtml) {
    console.log('[PROXY] Gateway not ready, serving loading page');

    // Start the gateway in the background (don't await)
    c.executionCtx.waitUntil(
      ensureMoltbotGateway(sandbox, c.env).catch((err: Error) => {
        console.error('[PROXY] Background gateway start failed:', err);
      }),
    );

    // Return the loading page immediately
    return c.html(loadingPageHtml);
  }

  // Ensure moltbot is running (this will wait for startup)
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[PROXY] Failed to start Moltbot:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    let hint = 'Check worker logs with: wrangler tail';
    if (!c.env.ANTHROPIC_API_KEY) {
      hint = 'ANTHROPIC_API_KEY is not set. Run: wrangler secret put ANTHROPIC_API_KEY';
    } else if (errorMessage.includes('heap out of memory') || errorMessage.includes('OOM')) {
      hint = 'Gateway ran out of memory. Try again or check for memory leaks.';
    }

    // Return HTML error page for browser requests, JSON for API requests
    if (acceptsHtml) {
      return c.html(
        `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Fehler</title>
        <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#e0e0e0;margin:0}
        .box{text-align:center;max-width:500px;padding:40px}.err{color:#f87171;margin:20px 0;padding:16px;background:rgba(248,113,113,0.1);border-radius:8px}
        a{color:#60a5fa}</style></head>
        <body><div class="box"><h1>Gateway konnte nicht gestartet werden</h1>
        <div class="err"><p>${errorMessage}</p><p><small>${hint}</small></p></div>
        <p><a href="javascript:location.reload()">Erneut versuchen</a></p></div></body></html>`,
        503,
      );
    }

    return c.json({ error: 'Gateway failed to start', details: errorMessage, hint }, 503);
  }

  // Proxy to Moltbot with WebSocket message interception
  if (isWebSocketRequest) {
    const debugLogs = c.env.DEBUG_ROUTES === 'true';
    const redactedSearch = redactSensitiveParams(url);

    console.log('[WS] Proxying WebSocket connection to Moltbot');
    if (debugLogs) {
      console.log('[WS] URL:', url.pathname + redactedSearch);
    }

    // Inject gateway token into WebSocket request if not already present.
    // CF Access redirects strip query params, so authenticated users lose ?token=.
    // Since the user already passed CF Access auth, we inject the token server-side.
    let wsRequest = request;
    if (c.env.MOLTBOT_GATEWAY_TOKEN && !url.searchParams.has('token')) {
      const tokenUrl = new URL(url.toString());
      tokenUrl.searchParams.set('token', c.env.MOLTBOT_GATEWAY_TOKEN);
      wsRequest = new Request(tokenUrl.toString(), request);
    }

    // Get WebSocket connection to the container
    const containerResponse = await sandbox.wsConnect(wsRequest, MOLTBOT_PORT);
    console.log('[WS] wsConnect response status:', containerResponse.status);

    // Get the container-side WebSocket
    const containerWs = containerResponse.webSocket;
    if (!containerWs) {
      console.error('[WS] No WebSocket in container response - falling back to direct proxy');
      return containerResponse;
    }

    if (debugLogs) {
      console.log('[WS] Got container WebSocket, setting up interception');
    }

    // Create a WebSocket pair for the client
    const [clientWs, serverWs] = Object.values(new WebSocketPair());

    // Accept both WebSockets
    serverWs.accept();
    containerWs.accept();

    if (debugLogs) {
      console.log('[WS] Both WebSockets accepted');
      console.log('[WS] containerWs.readyState:', containerWs.readyState);
      console.log('[WS] serverWs.readyState:', serverWs.readyState);
    }

    // Relay messages from client to container
    serverWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Client -> Container:',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 200) : '(binary)',
        );
      }
      if (containerWs.readyState === WebSocket.OPEN) {
        containerWs.send(event.data);
      } else if (debugLogs) {
        console.log('[WS] Container not open, readyState:', containerWs.readyState);
      }
    });

    // Relay messages from container to client, with filtering and error transformation
    containerWs.addEventListener('message', (event) => {
      if (debugLogs) {
        console.log(
          '[WS] Container -> Client (raw):',
          typeof event.data,
          typeof event.data === 'string' ? event.data.slice(0, 500) : '(binary)',
        );
      }
      let data = event.data;

      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);

          // Filter out internal/tool messages that should not reach the client
          if (isInternalMessage(parsed)) {
            const rawParams = JSON.stringify(parsed.parameters ?? parsed.input ?? {});
            if (rawParams.includes('[object Object]')) {
              console.warn('[WS] Malformed tool call suppressed – [object Object] in params:', parsed.name);
            } else if (debugLogs) {
              console.log('[WS] Filtered internal message (not forwarded):', parsed.type, parsed.name);
            }
            return; // Don't forward to client
          }

          // For mixed content (text + tool_use), strip tool blocks and only forward text
          const cleaned = stripToolBlocksFromContent(parsed);
          if (cleaned) {
            if (debugLogs) {
              console.log('[WS] Stripped tool blocks from mixed content message');
            }
            data = cleaned;
          }

          // Transform error messages to be user-friendly
          if (parsed.error?.message) {
            if (debugLogs) {
              console.log('[WS] Original error.message:', parsed.error.message);
            }
            parsed.error.message = transformErrorMessage(parsed.error.message, url.host);
            if (debugLogs) {
              console.log('[WS] Transformed error.message:', parsed.error.message);
            }
            data = JSON.stringify(parsed);
          }
        } catch {
          // Not JSON - pass through as-is (plain text messages)
          if (debugLogs) {
            console.log('[WS] Non-JSON message, passing through');
          }
        }
      }

      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(data);
      } else if (debugLogs) {
        console.log('[WS] Server not open, readyState:', serverWs.readyState);
      }
    });

    // Handle close events
    serverWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Client closed:', event.code, event.reason);
      }
      containerWs.close(event.code, event.reason);
    });

    containerWs.addEventListener('close', (event) => {
      if (debugLogs) {
        console.log('[WS] Container closed:', event.code, event.reason);
      }
      // Transform the close reason (truncate to 123 bytes max for WebSocket spec)
      let reason = transformErrorMessage(event.reason, url.host);
      if (reason.length > 123) {
        reason = reason.slice(0, 120) + '...';
      }
      if (debugLogs) {
        console.log('[WS] Transformed close reason:', reason);
      }
      serverWs.close(event.code, reason);
    });

    // Handle errors
    serverWs.addEventListener('error', (event) => {
      console.error('[WS] Client error:', event);
      containerWs.close(1011, 'Client error');
    });

    containerWs.addEventListener('error', (event) => {
      console.error('[WS] Container error:', event);
      serverWs.close(1011, 'Container error');
    });

    if (debugLogs) {
      console.log('[WS] Returning intercepted WebSocket response');
    }
    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  }

  console.log('[HTTP] Proxying:', url.pathname + url.search);

  const httpResponse = await sandbox.containerFetch(request, MOLTBOT_PORT);
  console.log('[HTTP] Response status:', httpResponse.status);

  // For JSON responses from AI chat, filter out tool call artifacts
  const contentType = httpResponse.headers.get('Content-Type') || '';
  if (contentType.includes('application/json') && httpResponse.status === 200) {
    try {
      const responseClone = httpResponse.clone();
      const body = await responseClone.json<Record<string, unknown>>();

      // Filter tool call responses - return a clean "processing" message instead
      if (isInternalMessage(body)) {
        console.log('[HTTP] Filtered tool call response from container');
        const newHeaders = new Headers(httpResponse.headers);
        newHeaders.set('X-Worker-Debug', 'proxy-filtered-tool-call');
        return new Response(
          JSON.stringify({ response: 'Einen Moment, ich verarbeite deine Anfrage...', status: 'processing' }),
          { status: 200, headers: newHeaders },
        );
      }

      // Strip tool blocks from mixed content in response fields
      if (body.response && typeof body.response === 'string') {
        try {
          const parsed = JSON.parse(body.response);
          if (isInternalMessage(parsed)) {
            const newHeaders = new Headers(httpResponse.headers);
            newHeaders.set('X-Worker-Debug', 'proxy-filtered-nested-tool-call');
            return new Response(
              JSON.stringify({ response: 'Einen Moment, ich verarbeite deine Anfrage...', status: 'processing' }),
              { status: 200, headers: newHeaders },
            );
          }
        } catch { /* not JSON nested content - that's fine */ }
      }

      // Clean [object Object] artifacts from response text
      if (body.response && typeof body.response === 'string' && body.response.includes('[object Object]')) {
        console.warn('[HTTP] Cleaned [object Object] from response');
        body.response = (body.response as string).replace(/\[object Object\]/g, '').trim();
        const newHeaders = new Headers(httpResponse.headers);
        newHeaders.set('X-Worker-Debug', 'proxy-cleaned-response');
        return new Response(JSON.stringify(body), { status: 200, headers: newHeaders });
      }
    } catch {
      /* not parseable JSON - pass through as-is */
    }
  }

  // Pass through the response with debug headers
  const newHeaders = new Headers(httpResponse.headers);
  newHeaders.set('X-Worker-Debug', 'proxy-to-moltbot');
  newHeaders.set('X-Debug-Path', url.pathname);

  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: newHeaders,
  });
});

export default {
  fetch: app.fetch,
};
