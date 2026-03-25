import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import {
  ensureMoltbotGateway,
  findExistingMoltbotProcess,
  syncToR2,
  waitForProcess,
} from '../gateway';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 *
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to list devices
    // Must specify --url and --token (OpenClaw v2026.2.3 requires explicit credentials with --url)
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run OpenClaw CLI to approve the device
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const proc = await sandbox.startProcess(
      `openclaw devices approve ${requestId} --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices
    const token = c.env.MOLTBOT_GATEWAY_TOKEN;
    const tokenArg = token ? ` --token ${token}` : '';
    const listProc = await sandbox.startProcess(
      `openclaw devices list --json --url ws://localhost:18789${tokenArg}`,
    );
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential device approval required
        const approveProc = await sandbox.startProcess(
          `openclaw devices approve ${device.requestId} --url ws://localhost:18789${tokenArg}`,
        );
        // eslint-disable-next-line no-await-in-loop
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        // eslint-disable-next-line no-await-in-loop
        const approveLogs = await approveProc.getLogs();
        const success =
          approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter((r) => r.success).length;
    return c.json({
      approved: results.filter((r) => r.success).map((r) => r.requestId),
      failed: results.filter((r) => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID &&
    c.env.R2_SECRET_ACCESS_KEY &&
    c.env.CF_ACCOUNT_ID
  );

  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  if (hasCredentials) {
    try {
      const result = await sandbox.exec('cat /tmp/.last-sync 2>/dev/null || echo ""');
      const timestamp = result.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');

  const result = await syncToR2(sandbox, c.env);

  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json(
      {
        success: false,
        error: result.error,
        details: result.details,
      },
      status,
    );
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find and kill the existing gateway process
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    if (existingProcess) {
      console.log('Killing existing gateway process:', existingProcess.id);
      try {
        await existingProcess.kill();
      } catch (killErr) {
        console.error('Error killing process:', killErr);
      }
      // Wait a moment for the process to die
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

// POST /api/refresh-token - Erneuert Google Access Token
api.options('/refresh-token', (c) => {
  return c.newResponse(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
});

api.post('/refresh-token', async (c) => {
  const body = await c.req.json<{ refresh_token: string }>();

  if (!body.refresh_token) {
    return c.newResponse(JSON.stringify({ error: 'Missing refresh_token' }), 400, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const googleClientId = (c.env as unknown as Record<string, string>).GOOGLE_CLIENT_ID;
  const googleClientSecret = (c.env as unknown as Record<string, string>).GOOGLE_CLIENT_SECRET;

  if (!googleClientId || !googleClientSecret) {
    return c.newResponse(JSON.stringify({ error: 'Google credentials not configured' }), 500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: body.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    return c.newResponse(JSON.stringify({ error: 'Refresh failed', details: error }), 401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  return c.newResponse(
    JSON.stringify({ access_token: data.access_token, expires_in: data.expires_in }),
    200,
    { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  );
});

// POST /api/analyze-file - Analyze uploaded file with Cloudflare Workers AI
api.options('/analyze-file', (c) => {
  return c.newResponse(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
});

api.post('/analyze-file', async (c) => {
  const body = await c.req.json<{
    file_name: string;
    file_type: string;
    file_content: string;
    user_tools: string[];
    autonomy_level: 'strict' | 'full_access';
  }>();

  const { file_name, file_type, file_content, user_tools, autonomy_level } = body;

  let fileAnalysis = '';

  if (file_type.startsWith('image/')) {
    try {
      const visionResult = await c.env.AI.run(
        '@cf/llava-hf/llava-1.5-7b-hf' as Parameters<Ai['run']>[0],
        {
          image: [...new Uint8Array(Uint8Array.from(atob(file_content), (ch) => ch.charCodeAt(0)))],
          prompt:
            'Describe this image in detail. What is it? Receipt, invoice, document, photo, screenshot? What actions could be taken?',
          max_tokens: 512,
        } as never,
      );
      fileAnalysis =
        (visionResult as { description?: string; response?: string }).description ||
        (visionResult as { description?: string; response?: string }).response ||
        '';
    } catch {
      fileAnalysis = '[Image analysis unavailable]';
    }
  } else if (file_type.startsWith('text/') || file_type === 'application/json') {
    fileAnalysis = file_content.substring(0, 3000);
  } else if (file_type === 'application/pdf') {
    fileAnalysis = '[PDF-Inhalt – Textextraktion folgt in späterem Update]';
  } else {
    fileAnalysis = `[Datei: ${file_name}]`;
  }

  const prompt = `Du bist Clouy, ein KI-Agent. Der User hat eine Datei hochgeladen.

Datei: ${file_name} (${file_type})
Inhalt: ${fileAnalysis.substring(0, 2000)}

Verbundene Tools: ${user_tools.join(', ') || 'Keine'}
Modus: ${autonomy_level}

Analysiere die Datei kurz (2-3 Sätze) und schlage passende Aktionen vor (nur für verbundene Tools).
Aktionstypen: send_email, create_event, save_to_drive, create_task

Formatiere Vorschläge als JSON-Block:
\`\`\`json
{
  "analysis": "...",
  "suggested_actions": [
    {
      "type": "send_email",
      "title": "Beschreibung",
      "details": { "to": "", "subject": "", "body": "" }
    }
  ]
}
\`\`\`
Wenn keine sinnvollen Aktionen möglich sind, lasse suggested_actions leer ([]).`;

  let analysisResponse = '';
  const aiResponse = await c.env.AI.run(
    '@cf/meta/llama-3.1-8b-instruct' as Parameters<Ai['run']>[0],
    {
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Analyse: ${file_name}` },
      ],
      max_tokens: 1024,
    },
  );
  analysisResponse = (aiResponse as { response: string }).response;

  return c.newResponse(JSON.stringify({ response: analysisResponse }), 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
});

// POST /api/create-checkout — Create Stripe checkout session
api.options('/create-checkout', (c) => {
  return c.newResponse(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
});

api.post('/create-checkout', async (c) => {
  const stripeKey = (c.env as unknown as Record<string, string>).STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return c.newResponse(JSON.stringify({ error: 'Stripe not configured' }), 500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const body = await c.req.json<{
    planId: string;
    userId: string;
    userEmail: string;
    yearly?: boolean;
  }>();
  const { planId, userId, userEmail, yearly } = body;

  const priceIds: Record<string, { monthly: string; yearly: string }> = {
    pro: { monthly: 'price_pro_monthly', yearly: 'price_pro_yearly' },
    team: { monthly: 'price_team_monthly', yearly: 'price_team_yearly' },
  };

  const prices = priceIds[planId];
  if (!prices) {
    return c.newResponse(JSON.stringify({ error: 'Invalid plan' }), 400, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const priceId = yearly ? prices.yearly : prices.monthly;

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'payment_method_types[]': 'card',
      mode: 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      customer_email: userEmail,
      'metadata[user_id]': userId,
      'metadata[plan_id]': planId,
      success_url: 'https://clouy.ai/dashboard?payment=success',
      cancel_url: 'https://clouy.ai/dashboard/pricing',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    return c.newResponse(JSON.stringify({ error: 'Stripe error', details: err }), 500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const session = (await response.json()) as { url: string; id: string };
  return c.newResponse(JSON.stringify({ url: session.url, sessionId: session.id }), 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
});

// POST /api/stripe-webhook — Handle Stripe webhook events
api.post('/stripe-webhook', async (c) => {
  const stripeKey = (c.env as unknown as Record<string, string>).STRIPE_SECRET_KEY;
  const webhookSecret = (c.env as unknown as Record<string, string>).STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = (c.env as unknown as Record<string, string>).SUPABASE_URL;
  const supabaseServiceKey = (c.env as unknown as Record<string, string>).SUPABASE_SERVICE_ROLE_KEY;

  if (!stripeKey || !webhookSecret) {
    return c.newResponse(JSON.stringify({ error: 'Stripe not configured' }), 500, {
      'Content-Type': 'application/json',
    });
  }

  const body = await c.req.text();
  const signature = c.req.header('stripe-signature') || '';

  // Verify webhook signature
  const parts = signature.split(',').reduce((acc: Record<string, string>, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const expectedSig = parts['v1'];

  if (!timestamp || !expectedSig) {
    return c.newResponse(JSON.stringify({ error: 'Invalid signature' }), 400, {
      'Content-Type': 'application/json',
    });
  }

  const signedPayload = `${timestamp}.${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (computedSig !== expectedSig) {
    return c.newResponse(JSON.stringify({ error: 'Signature mismatch' }), 400, {
      'Content-Type': 'application/json',
    });
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(body);
  } catch {
    return c.newResponse(JSON.stringify({ error: 'Invalid JSON' }), 400, {
      'Content-Type': 'application/json',
    });
  }

  // Handle relevant events
  if (supabaseUrl && supabaseServiceKey) {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = (session['metadata'] as Record<string, string>)?.['user_id'];
      const planId = (session['metadata'] as Record<string, string>)?.['plan_id'];
      const customerId = session['customer'] as string;
      const subscriptionId = session['subscription'] as string;

      if (userId && planId) {
        await fetch(`${supabaseUrl}/rest/v1/user_plans`, {
          method: 'POST',
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            user_id: userId,
            plan: planId,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          }),
        });
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const customerId = sub['customer'] as string;

      // Downgrade to free
      await fetch(`${supabaseUrl}/rest/v1/user_plans?stripe_customer_id=eq.${customerId}`, {
        method: 'PATCH',
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ plan: 'free', stripe_subscription_id: null }),
      });
    }
  }

  return c.newResponse(JSON.stringify({ received: true }), 200, {
    'Content-Type': 'application/json',
  });
});

// POST /api/create-portal — Create Stripe customer portal session
api.options('/create-portal', (c) => {
  return c.newResponse(null, 204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
});

api.post('/create-portal', async (c) => {
  const stripeKey = (c.env as unknown as Record<string, string>).STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return c.newResponse(JSON.stringify({ error: 'Stripe not configured' }), 500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const body = await c.req.json<{ customerId: string }>();
  const { customerId } = body;

  const response = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      customer: customerId,
      return_url: 'https://clouy.ai/dashboard/settings',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    return c.newResponse(JSON.stringify({ error: 'Stripe error', details: err }), 500, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
  }

  const portal = (await response.json()) as { url: string };
  return c.newResponse(JSON.stringify({ url: portal.url }), 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
});

export { api };
