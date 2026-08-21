/** Defines the operator-manifest-gated WhatsApp send canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.whatsapp.confirmed-send",
  title: "Provider-qualified WhatsApp confirmed-send canary",
  provider: "whatsapp",
  connectorProvider: "whatsapp",
  operation: "message-send",
  plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-whatsapp"],
  effectLabel: "message send",
  targetLabel: "WhatsApp canary chat",
  payload: "WhatsApp provider canary delivery",
});
