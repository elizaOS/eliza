/**
 * The first-provision "bootstrap window" of a DEDICATED agent.
 *
 * A freshly-created dedicated agent (alwaysOn/custom/etc.) has no container yet —
 * provisioning takes ~30-120s. During that window its own subdomain returns 202
 * "starting" and a first chat would hang/time out. To avoid that dead first-run
 * experience, the in-Worker shared runtime serves the user immediately (the
 * "shared agent that is always running"); the client hands off to the dedicated
 * subdomain once it reports `running`. See:
 *   - resolve-shared-agent.ts (lets the shared REST adapter serve the agent)
 *   - eliza-sandbox.ts `bridge` / `getSharedRuntimeCharacter` (runs the turn)
 *   - ui/api/client-cloud.ts `selectOrProvisionCloudAgent` (starts on the shared
 *     base, then hands off)
 *
 * Scoped to the genuine first-boot window ONLY: a dedicated agent that has never
 * had a reachable container (`bridge_url` is null) and is still `pending` /
 * `provisioning`. It deliberately excludes a `running` agent (use the subdomain),
 * an established agent that went `stopped`/`sleeping`/`disconnected` (its client
 * is on the subdomain; the proxy wakes it) and an `error` agent (surface the
 * failure). This keeps the shared-runtime serve additive to a path that today
 * fails, never overriding a working flow.
 */
export function isDedicatedBootstrapWindow(agent: {
  execution_tier: string;
  status: string;
  bridge_url: string | null;
}): boolean {
  if (agent.execution_tier === "shared") return false;
  if (agent.bridge_url) return false;
  return agent.status === "pending" || agent.status === "provisioning";
}
