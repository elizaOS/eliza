/** Defines the operator-manifest-gated Signal send canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.signal.confirmed-send",
  title: "Provider-qualified Signal confirmed-send canary",
  provider: "signal",
  operation: "message-send",
  plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-signal"],
  effectLabel: "message send",
  targetLabel: "operator-owned Signal canary chat",
  payload: "Signal provider canary delivery",
});
