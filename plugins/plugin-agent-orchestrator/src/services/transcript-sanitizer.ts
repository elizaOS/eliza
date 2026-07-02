/**
 * Shared sanitizer for sub-agent completion relay text.
 *
 * The orchestrator captures raw tool results into structured envelope blocks
 * ("[tool output: <title>]\n<body>\n[/tool output]", emitted by
 * captureTerminalToolOutput in acp-service). Those markers are OURS, not model
 * prose, and must never reach a user-facing surface (Discord, etc.). This
 * module centralizes stripping them so every relay path — the sub-agent router
 * AND the swarm-synthesis path (issue elizaOS/eliza#11578) — shares one robust
 * implementation instead of a router-private copy the synthesis path lacked.
 */

/** The closing marker captureTerminalToolOutput appends to every block. */
const TOOL_OUTPUT_END_MARKER = "[/tool output]";

/**
 * Default hard cap for any single remnant of text after envelope stripping.
 * A deliverable above this is a multi-KB transcript dump, not a user answer, so
 * we elide it rather than relaying it verbatim. Mirrors the 2KB verbatim cap
 * the router already applies to captured deliverables.
 */
export const DEFAULT_MAX_RELAY_CHARS = 2000;

/**
 * Remove the orchestrator's OWN captured tool-output envelope blocks from relay
 * text. Robust to:
 *  - well-formed blocks with a title
 *  - empty-title blocks: `[tool output: ]` / `[tool output:]`
 *  - MULTIPLE blocks in one string
 *  - an UNTERMINATED trailing block: a dangling `[tool output:` with no closing
 *    `[/tool output]` (a truncated capture) is stripped from the marker to end.
 *
 * Preserves all surrounding prose and plain URLs (envelopes carry an explicit
 * `[/tool output]` fence or run to end-of-string; prose between blocks is
 * untouched). This matches the router's historical stripToolTranscript output
 * for the well-formed case so its existing tests stay green.
 */
export function stripToolTranscript(text: string): string {
  if (!text) return "";
  return (
    text
      // Well-formed and empty-title blocks (non-greedy body up to the fence).
      .replace(/\[tool output:[^\]]*\][\s\S]*?\[\/tool output\]/g, "")
      // Unterminated trailing block: dangling opener with no closing fence.
      // Only fires if a `[tool output:` marker remains AFTER the pass above,
      // which means it was never closed — strip it to end of string.
      .replace(/\[tool output:[\s\S]*$/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Hard-cap any oversized text remnant. If `text` exceeds `maxChars`, replace it
 * entirely with a short elision marker recording the original length. Applied
 * AFTER envelope stripping as defense-in-depth: even a remnant that is not a
 * recognized envelope (raw JSON, an unfenced dump) is bounded before relay.
 */
export function elideLongBlocks(
  text: string,
  maxChars: number = DEFAULT_MAX_RELAY_CHARS,
): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `[output elided — ${text.length} chars]`;
}

/**
 * Full relay-sanitization pipeline: strip envelope blocks, then hard-cap the
 * remainder. Returns "" when nothing survives (callers substitute their own
 * default, e.g. "Task completed.").
 */
export function sanitizeCompletionRelay(
  text: string | undefined | null,
  maxChars: number = DEFAULT_MAX_RELAY_CHARS,
): string {
  if (!text) return "";
  return elideLongBlocks(stripToolTranscript(text), maxChars);
}

export { TOOL_OUTPUT_END_MARKER };
