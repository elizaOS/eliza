/**
 * Loopback URL redaction for user-facing sub-agent text. A coding child
 * verifies its page on the supervisor's loopback port and narrates that URL;
 * chat must never carry it (it is unreachable for the user and names an
 * internal port). Shared by the router narration and the completion
 * evaluator's delivery funnel.
 */

const LOOPBACK_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[?::1\]?)(?::\d{1,5})?(?:\/[^\s)<>"`]*)?/gi;

export function redactLoopbackUrls(text: string): string {
  if (!text) return text;
  LOOPBACK_URL_PATTERN.lastIndex = 0;
  if (!LOOPBACK_URL_PATTERN.test(text)) return text;
  LOOPBACK_URL_PATTERN.lastIndex = 0;
  const stripped = text
    .replace(LOOPBACK_URL_PATTERN, "")
    .replace(/[ \t]+\n/g, "\n");
  // Drop lines that became orphan punctuation after the URL was removed
  // (e.g. "- " or "* " markdown list bullets pointing at nothing).
  return stripped
    .split("\n")
    .filter((line) => !/^[-*\s]*[:>→\->]?[\s]*$/.test(line) || line === "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
