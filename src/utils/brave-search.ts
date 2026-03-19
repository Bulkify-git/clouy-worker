export interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export async function braveWebSearch(
  query: string,
  apiKey: string,
  count = 5,
): Promise<BraveSearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API returned ${response.status}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    description: r.description ?? '',
  }));
}

export function formatSearchResultsAsContext(
  query: string,
  results: BraveSearchResult[],
): string {
  if (results.length === 0) {
    return `[Web search for "${query}" returned no results.]`;
  }
  const formatted = results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`)
    .join('\n\n');
  return `[Web search results for "${query}"]\n\n${formatted}\n\n[Answer the user's question using these search results. Cite sources where appropriate.]`;
}
