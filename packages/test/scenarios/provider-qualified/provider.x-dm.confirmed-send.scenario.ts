/** Defines the operator-manifest-gated X direct-message send canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.x-dm.confirmed-send",
  title: "Provider-qualified X DM confirmed-send canary",
  provider: "x-dm",
  operation: "message-send",
  plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-x"],
  effectLabel: "direct-message send",
  targetLabel: "X canary conversation",
  payload: "X provider canary delivery",
});
