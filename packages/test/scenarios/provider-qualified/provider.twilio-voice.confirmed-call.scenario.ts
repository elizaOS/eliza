/** Defines the operator-manifest-gated Twilio voice call canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.twilio-voice.confirmed-call",
  title: "Provider-qualified Twilio voice confirmed-call canary",
  provider: "twilio-voice",
  operation: "call-create",
  plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-phone"],
  effectLabel: "voice call",
  targetLabel: "Twilio canary number",
  payload: "Twilio voice provider canary call",
});
