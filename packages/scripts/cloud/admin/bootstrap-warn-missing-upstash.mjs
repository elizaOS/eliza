/**
 * Loud-warn helper extracted from bootstrap-provisioning-worker-host.mjs
 * (PR #7747) so it can be exercised in unit tests without invoking the full
 * Hetzner / SSH bootstrap script (which has top-level side effects).
 *
 * Sandbox containers boot a `SandboxRegistry` (packages/app-core) that
 * publishes `agent:<id>:server` / `server:<name>:url` keys to the shared
 * Upstash so gateway-discord and gateway-webhook can route inbound platform
 * messages to them. Without these keys on the orchestrator host the
 * registration step silently no-ops and Discord / WhatsApp / Telegram / SMS
 * traffic to those sandboxes is black-holed.
 *
 * Importantly, `MOCK_REDIS=1` is a test-time opt-in for individual services;
 * it does NOT substitute for real Upstash creds on the orchestrator host, so
 * this warning must still fire when MOCK_REDIS=1 is set but the Upstash keys
 * are absent from the env file.
 *
 * @param env parsed env object (e.g. from dotenv.parse) — NOT process.env
 * @param write injected writer (defaults to process.stderr.write)
 * @returns true if the warning was written, false if both keys were present
 */
export function warnMissingUpstash(env, write = (s) => process.stderr.write(s)) {
  const missing = ["KV_REST_API_URL", "KV_REST_API_TOKEN"].filter(
    (key) => !env[key]?.trim(),
  );
  if (missing.length === 0) return false;
  write(
    [
      "",
      "[bootstrap-provisioning-worker-host] WARNING:",
      `  Runtime env is missing ${missing.join(" + ")}.`,
      "  Sandboxes provisioned by this worker will not self-register in Upstash,",
      "  so the shared gateways cannot route inbound Discord / WhatsApp /",
      "  Telegram / SMS messages to them.",
      "  Add both keys to the env file and re-run if platform routing is needed.",
      "",
    ].join("\n"),
  );
  return true;
}
