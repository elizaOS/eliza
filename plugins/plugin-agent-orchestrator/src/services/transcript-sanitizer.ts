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
 * Remove the orchestrator's OWN captured tool-output envelope blocks from relay
 * text. Robust to:
 *  - well-formed blocks with a title
 *  - empty-title blocks: `[tool output: ]` / `[tool output:]`
 *  - MULTIPLE blocks in one string
 *  - an UNTERMINATED trailing block: a dangling `[tool output:` with no closing
 *    `[/tool output]` is stripped from the marker to end.
 *
 * Preserves all surrounding prose and plain URLs (envelopes carry an explicit
 * `[/tool output]` fence or run to end-of-string; prose between blocks is
 * untouched). This matches the router's historical stripToolTranscript output
 * for the well-formed case so its existing tests stay green.
 */
export function stripToolTranscript(text: string): string {
  if (!text) return "";
  const opener = "[tool output:";
  const closer = "[/tool output]";
  const fragments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const blockStart = text.indexOf(opener, cursor);
    if (blockStart < 0) break;
    const titleEnd = text.indexOf("]", blockStart + opener.length);
    if (titleEnd < 0) {
      fragments.push(text.slice(cursor, blockStart));
      cursor = text.length;
      break;
    }
    const blockEnd = text.indexOf(closer, titleEnd + 1);
    fragments.push(text.slice(cursor, blockStart));
    if (blockEnd < 0) {
      cursor = text.length;
      break;
    }
    cursor = blockEnd + closer.length;
  }
  fragments.push(text.slice(cursor));
  return fragments
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip the orchestrator's OWN completion-envelope summary lines
 * (summarizeEnvelope in completion-envelope.ts: `diff: …`, `workdir: …`,
 * `files: N`, `tests: …`, `criteria: N/M met`, …). Those lines are verifier/log
 * machine format, not model prose — when a completion summary carries them into
 * a chat relay the user sees internal paths and counters. Line-anchored on the
 * exact canonical field prefixes so builder prose is untouched.
 */
const ENVELOPE_SUMMARY_LINE =
  /^(?:diff|workdir|files|verifiedFiles|tests|criteria|unmet|risks|UNVERIFIED missing): /;

export function stripEnvelopeSummaryLines(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((line) => !ENVELOPE_SUMMARY_LINE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip the canonical structured-proof completion lines our create prompts
 * demand from builders (`APP_CREATE_DONE {...}` / `PLUGIN_CREATE_DONE {...}`).
 * They are machine proof for the validator, not chat. When a stripped line
 * carries a `liveUrl` the user-facing text keeps that one load-bearing fact as
 * plain prose (unless the surrounding text already states the URL).
 */
const STRUCTURED_PROOF_LINE = /(?:APP|PLUGIN)_CREATE_DONE\s*\{/;

export function stripStructuredProofLines(text: string): string {
  if (!text) return "";
  const kept: string[] = [];
  const liveUrls: string[] = [];
  for (const line of text.split("\n")) {
    if (!STRUCTURED_PROOF_LINE.test(line.trim())) {
      kept.push(line);
      continue;
    }
    const url = line.match(/"liveUrl"\s*:\s*"([^"]+)"/)?.[1];
    if (url) liveUrls.push(url);
  }
  let out = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  for (const url of liveUrls) {
    if (!out.includes(url)) {
      out = out ? `${out}\nLive at ${url}` : `Live at ${url}`;
    }
  }
  return out;
}

/**
 * Full relay-sanitization pipeline: strip envelope blocks, envelope summary
 * lines, and structured-proof lines. Returns ""
 * when nothing survives (callers substitute their own default, e.g.
 * "Task completed.").
 */
export function sanitizeCompletionRelay(
  text: string | undefined | null,
  _maxChars?: number,
): string {
  if (!text) return "";
  const stripped = stripStructuredProofLines(
    stripEnvelopeSummaryLines(stripToolTranscript(text)),
  );
  return stripped;
}

export { TOOL_OUTPUT_END_MARKER };
