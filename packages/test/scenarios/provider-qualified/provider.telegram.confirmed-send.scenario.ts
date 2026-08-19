/** Defines the operator-manifest-gated Telegram send canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.telegram.confirmed-send",
  title: "Provider-qualified Telegram confirmed-send canary",
  provider: "telegram",
  operation: "message-send",
  plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-telegram"],
  effectLabel: "message send",
  targetLabel: "Telegram saved-messages canary",
  payload: "Telegram provider canary delivery",
});
