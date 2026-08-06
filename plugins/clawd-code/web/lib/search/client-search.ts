import type { Conversation, SearchFilters, SearchResult, SearchResultMatch } from "@/lib/types";
import { extractTextContent } from "@/lib/utils";
import { tokenize, excerpt, highlight } from "./highlighter";

/**
 * Score a text against a set of query tokens.
 * Returns 0 if no tokens match, otherwise a positive score.
 */
function scoreText(text: string, tokens: string[]): number {
  if (!text || tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;

  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx === -1) continue;

    // Base score per token
    score += 1;

    // Bonus for word boundary match
    const before = idx === 0 || /\W/.test(lower[idx - 1]);
    const after = idx + token.length >= lower.length || /\W/.test(lower[idx + token.length]);
    if (before && after) score += 0.5;

    // Bonus for more occurrences (capped)
    const count = (lower.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    score += Math.min(count - 1, 3) * 0.2;
  }

  // Penalty if not all tokens match
  const matchedTokens = tokens.filter((t) => lower.includes(t));
  if (matchedTokens.length < tokens.length) {
    score *= matchedTokens.length / tokens.length;
  }

  return score;
}

/**
 * Extract plain-text content from a message for indexing.
 */
function messageText(content: Conversation["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `${block.name} ${JSON.stringify(block.input)}`;
      if (block.type === "tool_result") {
        return typeof block.content === "string"
          ? block.content
          : extractTextContent(block.content);
      }
      return "";
    })
    .join(" ");
}

/**
 * Run a client-side full-text search over an array of conversations.
 * Returns results sorted by relevance (highest score first).
 */
export function clientSearch(
  conversations: Conversation[],
  query: string,
  filters: SearchFilters = {}
): SearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0 && !hasActiveFilters(filters)) return [];

  const results: SearchResult[] = [];
  const now = Date.now();

  for (const conv of conversations) {
    // --- Date filter ---
    if (filters.dateFrom && conv.updatedAt < filters.dateFrom) continue;
    if (filters.dateTo && conv.updatedAt > filters.dateTo + 86_400_000) continue;

    // --- Conversation filter ---
    if (filters.conversationId && conv.id !== filters.conversationId) continue;

    // --- Model filter ---
    if (filters.model && conv.model !== filters.model) continue;

    // --- Tag filter ---
    if (filters.tagIds && filters.tagIds.length > 0) {
      const convTags = new Set(conv.tags ?? []);
      if (!filters.tagIds.some((tid) => convTags.has(tid))) continue;
    }

    const matches: SearchResultMatch[] = [];
    let titleScore = 0;

    // Score the conversation title
    if (tokens.length > 0) {
      titleScore = scoreText(conv.title, tokens) * 1.5; // title matches weight more
    }

    for (const msg of conv.messages) {
      // --- Role filter ---
      if (filters.role && msg.role !== filters.role) continue;

      // --- Content type filter ---
      if (filters.contentType) {
        const hasType = matchesContentType(msg.content, filters.contentType);
        if (!hasType) continue;
      }

      const text = messageText(msg.content);
      if (!text) continue;

      let msgScore = tokens.length > 0 ? scoreText(text, tokens) : 1;
      if (msgScore === 0) continue;

      const ex = excerpt(text, query);
      const hl = highlight(ex, query);

      matches.push({
        messageId: msg.id,
        role: msg.role,
        excerpt: ex,
        highlighted: hl,
        score: msgScore,
      });
    }

    if (tokens.length === 0) {
      // Filter-only mode: include conversation with a synthetic match on the title
      results.push({
        conversationId: conv.id,
        conversationTitle: conv.title,
        conversationDate: conv.updatedAt,
        conversationModel: conv.model,
        matches: matches.length > 0 ? matches.slice(0, 5) : [],
        totalScore: 1,
      });
      continue;
    }

    if (matches.length === 0 && titleScore === 0) continue;

    const totalScore =
      titleScore + matches.reduce((sum, m) => sum + m.score, 0);

    // Sort matches by score descending, keep top 5
    matches.sort((a, b) => b.score - a.score);

    results.push({
      conversationId: conv.id,
      conversationTitle: conv.title,
      conversationDate: conv.updatedAt,
      conversationModel: conv.model,
      matches: matches.slice(0, 5),
      totalScore,
    });
  }

  // Sort results by total score descending
  results.sort((a, b) => b.totalScore - a.totalScore);
  return results;
}

function hasActiveFilters(filters: SearchFilters): boolean {
  return !!(
    filters.dateFrom ||
    filters.dateTo ||
    filters.role ||
    filters.conversationId ||
    filters.contentType ||
    filters.model ||
    (filters.tagIds && filters.tagIds.length > 0)
  );
}

function matchesContentType(
  content: Conversation["messages"][number]["content"],
  type: NonNullable<SearchFilters["contentType"]>
): boolean {
  if (typeof content === "string") return type === "text";
  if (!Array.isArray(content)) return false;

  return content.some((block) => {
    if (type === "text" && block.type === "text") return true;
    if (type === "tool_use" && block.type === "tool_use") return true;
    if (type === "file" && block.type === "tool_use" && block.name?.includes("file")) return true;
    if (type === "code" && block.type === "text") {
      return block.text.includes("```") || block.text.includes("    ");
    }
    return false;
  });
}
