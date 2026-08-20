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

import { stripCompletionEnvelope } from "./completion-envelope.js";

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
 * Hard-cap any oversized text remnant. If `text` exceeds `maxChars`, TRUNCATE
 * it: keep the head and append a marker recording the original length. Applied
 * AFTER envelope stripping as defense-in-depth: even a remnant that is not a
 * recognized envelope (raw JSON, an unfenced dump) is bounded before relay.
 *
 * Never replaces the text wholesale — a legit long deliverable (a pure-prose
 * plan or report over the cap) must relay its head, not vanish into a marker
 * (regression from 37813124bf / #11605: the synthesis path posted literally
 * "[output elided — N chars]" as the completion summary).
 *
 * The truncated result is bounded to `maxChars`, so re-applying this function
 * (buildTaskResultLine re-sanitizes defensively) is a no-op.
 */
export function elideLongBlocks(
  text: string,
  maxChars: number = DEFAULT_MAX_RELAY_CHARS,
): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const marker = `… [output truncated — ${text.length} chars total]`;
  const headBudget = maxChars - marker.length - 1; // 1 = joining newline
  if (headBudget <= 0) return marker; // degenerate tiny cap: marker only
  return `${text.slice(0, headBudget).trimEnd()}\n${marker}`;
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
 * lines, and structured-proof lines, then hard-cap the remainder. Returns ""
 * when nothing survives (callers substitute their own default, e.g.
 * "Task completed.").
 */
export function sanitizeCompletionRelay(
  text: string | undefined | null,
  maxChars: number = DEFAULT_MAX_RELAY_CHARS,
): string {
  if (!text) return "";
  const stripped = stripStructuredProofLines(
    stripEnvelopeSummaryLines(
      stripCompletionEnvelope(stripToolTranscript(text)),
    ),
  );
  let out = elideLongBlocks(stripped, maxChars);
  // The liveUrl rescue appends at the tail, which is exactly what elision
  // truncates — re-assert it after the cap so the one load-bearing fact
  // survives an oversized deliverable (bounded overshoot: one URL line).
  const liveUrl = stripped.match(/^Live at (\S+)$/m)?.[1];
  if (liveUrl && !out.includes(liveUrl)) {
    out = `${out}\nLive at ${liveUrl}`;
  }
  return out;
}

export { TOOL_OUTPUT_END_MARKER };
