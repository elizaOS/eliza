/**
 * Full-text search worker.
 * Maintains an in-memory index of conversation messages so search queries
 * never block the main thread.
 *
 * Messages in:
 *   { type: "index";  id: string; entries: SearchEntry[] }
 *   { type: "query";  id: string; query: string; limit?: number }
 *   { type: "remove"; id: string; conversationId: string }
 *
 * Messages out:
 *   { id: string; results: SearchResult[] }
 */

export interface SearchEntry {
  conversationId: string;
  messageId: string;
  text: string;
  role: "user" | "assistant";
  createdAt: number;
}

export interface SearchResult {
  conversationId: string;
  messageId: string;
  snippet: string;
  score: number;
  createdAt: number;
}

type InMessage =
  | { type: "index"; id: string; entries: SearchEntry[] }
  | { type: "query"; id: string; query: string; limit?: number }
  | { type: "remove"; id: string; conversationId: string };

// Simple inverted index: term → Set of entry indices
const index = new Map<string, Set<number>>();
const entries: SearchEntry[] = [];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 2);
}

function addEntry(entry: SearchEntry): void {
  const idx = entries.length;
  entries.push(entry);
  for (const token of tokenize(entry.text)) {
    if (!index.has(token)) index.set(token, new Set());
    index.get(token)!.add(idx);
  }
}

function removeConversation(conversationId: string): void {
  // Mark entries as removed (nullish id) — we rebuild if fragmentation grows
  for (const entry of entries) {
    if (entry.conversationId === conversationId) {
      (entry as { conversationId: string }).conversationId = "__removed__";
    }
  }
  // Prune index entries that only point to removed items
  for (const [token, set] of index) {
    for (const idx of set) {
      if (entries[idx].conversationId === "__removed__") set.delete(idx);
    }
    if (set.size === 0) index.delete(token);
  }
}

function extractSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const pos = lower.indexOf(query.toLowerCase().split(/\s+/)[0]);
  if (pos < 0) return text.slice(0, 120) + (text.length > 120 ? "…" : "");
  const start = Math.max(0, pos - 40);
  const end = Math.min(text.length, pos + 80);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function query(
  q: string,
  limit = 20
): SearchResult[] {
  const tokens = tokenize(q);
  if (!tokens.length) return [];

  // Score by how many query tokens appear
  const scores = new Map<number, number>();
  for (const token of tokens) {
    for (const [term, set] of index) {
      if (term.includes(token)) {
        const boost = term === token ? 2 : 1; // exact > partial
        for (const idx of set) {
          scores.set(idx, (scores.get(idx) ?? 0) + boost);
        }
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([idx, score]) => {
      const entry = entries[idx];
      return {
        conversationId: entry.conversationId,
        messageId: entry.messageId,
        snippet: extractSnippet(entry.text, q),
        score,
        createdAt: entry.createdAt,
      };
    })
    .filter((r) => r.conversationId !== "__removed__");
}

self.addEventListener("message", (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case "index":
      for (const entry of msg.entries) addEntry(entry);
      self.postMessage({ id: msg.id, results: [] });
      break;
    case "query":
      self.postMessage({ id: msg.id, results: query(msg.query, msg.limit) });
      break;
    case "remove":
      removeConversation(msg.conversationId);
      self.postMessage({ id: msg.id, results: [] });
      break;
  }
});
