/** Converts every Google grounding chunk into a source result, with only explicit caller paging. */
export interface GroundedSearchResponse {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
      groundingSupports?: Array<{
        segment?: { text?: string };
        groundingChunkIndices?: number[];
        confidenceScores?: number[];
      }>;
    };
  }>;
}

export interface GroundedSearchResultItem {
  title: string;
  url: string;
  content: string;
  score: number;
}

export function buildSearchResults(
  response: GroundedSearchResponse,
  maxResults?: number,
): GroundedSearchResultItem[] {
  const grounding = response.candidates?.[0]?.groundingMetadata;
  const chunks = grounding?.groundingChunks ?? [];
  const supports = grounding?.groundingSupports ?? [];
  const byUrl = new Map<string, { title: string; content: string[]; scores: number[] }>();

  for (const support of supports) {
    const snippet = support.segment?.text?.trim();
    const scores = support.confidenceScores ?? [];
    for (const index of support.groundingChunkIndices ?? []) {
      const chunk = chunks[index];
      const url = chunk?.web?.uri?.trim();
      if (!url) continue;
      const current = byUrl.get(url) ?? {
        title: chunk?.web?.title?.trim() || url,
        content: [],
        scores: [],
      };
      if (snippet && !current.content.includes(snippet)) {
        current.content.push(snippet);
      }
      for (const score of scores) {
        if (typeof score === "number" && Number.isFinite(score)) {
          current.scores.push(score);
        }
      }
      byUrl.set(url, current);
    }
  }

  for (const chunk of chunks) {
    const url = chunk?.web?.uri?.trim();
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      title: chunk?.web?.title?.trim() || url,
      content: [],
      scores: [],
    });
  }

  const results = Array.from(byUrl.entries()).map(([url, value]) => ({
    title: value.title,
    url,
    content: value.content.join(" ").trim(),
    score:
      value.scores.length > 0
        ? value.scores.reduce((total, score) => total + score, 0) / value.scores.length
        : 1,
  }));
  return maxResults === undefined ? results : results.slice(0, maxResults);
}
