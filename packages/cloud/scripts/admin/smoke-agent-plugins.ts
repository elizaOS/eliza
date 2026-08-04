/**
 * The minimal plugin set a throwaway cloud smoke-test agent needs: SQL storage
 * plus the elizacloud model/route plugin. Shared by the live provisioning smoke
 * (live-cloud-provision-smoke.ts) and the Hetzner E2E deploy heartbeat
 * (hetzner-e2e/hetzner-e2e-deploy-agent.ts) so the two agree by construction —
 * a single edit changes both, and neither carries its own copy of the list.
 */
export const SMOKE_AGENT_PLUGINS = [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-elizacloud",
] as const;
