/**
 * Sanitizes sub-agent completion text before it reaches user-facing relays.
 *
 * Orchestrator tool envelopes and proof summaries are machine protocol, while
 * plain prose and deployment URLs are deliverables. Keeping the distinction in
 * this dependency-neutral package lets both the agent server and orchestrator
 * apply the same bounded transformation without coupling runtime startup to an
 * optional plugin.
 */

/** The closing marker appended to every captured tool-output envelope. */
export const TOOL_OUTPUT_END_MARKER = "[/tool output]";

/** Maximum size of a relay remnant after protocol envelopes are removed. */
export const DEFAULT_MAX_RELAY_CHARS = 2000;

/**
 * Removes complete or truncated captured tool-output envelopes while
 * preserving surrounding prose.
 */
export function stripToolTranscript(text: string): string {
  if (!text) return "";
  return (
    text
      .replace(/\[tool output:[^\]]*\][\s\S]*?\[\/tool output\]/g, "")
      // Any opener left after the complete-block pass is an interrupted tail.
      .replace(/\[tool output:[\s\S]*$/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Bounds oversized relay text while retaining its useful leading content and
 * recording the original size. The bounded form is idempotent because it is
 * short enough to pass through unchanged when callers sanitize defensively.
 */
export function elideLongBlocks(
  text: string,
  maxChars: number = DEFAULT_MAX_RELAY_CHARS,
): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const marker = `… [output truncated — ${text.length} chars total]`;
  const headBudget = maxChars - marker.length - 1;
  if (headBudget <= 0) return marker;
  return `${text.slice(0, headBudget).trimEnd()}\n${marker}`;
}

const ENVELOPE_SUMMARY_LINE =
  /^(?:diff|workdir|files|verifiedFiles|tests|criteria|unmet|risks|UNVERIFIED missing): /;

/** Removes canonical completion-envelope fields without matching prose. */
export function stripEnvelopeSummaryLines(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .filter((line) => !ENVELOPE_SUMMARY_LINE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const STRUCTURED_PROOF_LINE = /(?:APP|PLUGIN)_CREATE_DONE\s*\{/;

/**
 * Removes machine-readable creation proof while preserving a proof line's
 * deployment URL when surrounding prose does not already contain it.
 */
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

/** Applies the complete user-facing completion-relay sanitation pipeline. */
export function sanitizeCompletionRelay(
  text: string | undefined | null,
  maxChars: number = DEFAULT_MAX_RELAY_CHARS,
): string {
  if (!text) return "";
  const stripped = stripStructuredProofLines(
    stripEnvelopeSummaryLines(stripToolTranscript(text)),
  );
  let out = elideLongBlocks(stripped, maxChars);
  // Deployment URLs remain load-bearing even when the preceding prose is long.
  const liveUrl = stripped.match(/^Live at (\S+)$/m)?.[1];
  if (liveUrl && !out.includes(liveUrl)) {
    out = `${out}\nLive at ${liveUrl}`;
  }
  return out;
}
