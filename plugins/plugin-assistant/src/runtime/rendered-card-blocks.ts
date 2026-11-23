/**
 * Client-rendered card blocks in tool-owned reply text.
 *
 * Actions attach cards a chat surface draws instead of prose: a bracket open
 * marker on its own line, one complete JSON object on the next line, and the
 * matching close marker (`[MAPSCARD]\n{json}\n[/MAPSCARD]` from plugin-maps
 * card.ts; the dashboard's `[CHECKLIST]` / `[WORKFLOW]` widget blocks use the
 * same shape). The block is wire grammar for the renderer, not text: wrapping
 * it in a Markdown code fence hides it from the card parser's intent and shows
 * the user literal ``` lines around a duplicated list.
 *
 * Match only tags that a client renders. Other bracketed JSON may be
 * ordinary command output and still needs its fence and evaluator reply.
 */

const CARD_BLOCK_RE =
  /(?:^|\n)[ \t]*\[(MAPSCARD|CHECKLIST|WORKFLOW)\][ \t]*\r?\n[ \t]*(\{[^\n]*\})[ \t]*\r?\n[ \t]*\[\/\1\][ \t]*(?=\r?\n|$)/g;

/** True when `text` carries at least one well-formed client-rendered card block. */
export function containsRenderedCardBlock(text: string): boolean {
  if (!text.includes("[/")) return false;
  CARD_BLOCK_RE.lastIndex = 0;
  for (const match of text.matchAll(CARD_BLOCK_RE)) {
    const body = match[2];
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return true;
      }
    } catch {
      // error-policy:J3 a non-JSON body is literal text, not a card.
    }
  }
  return false;
}
