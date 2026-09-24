/** Classifies duplicate upstream API listen lines hidden by the dev orchestrator. */

const UPSTREAM_API_LISTEN_RE =
  /\[eliza-api\]\s+Listening on https?:\/\/[^\s]+/i;

export function isRedundantApiListenLine(line) {
  return UPSTREAM_API_LISTEN_RE.test(String(line ?? ""));
}
