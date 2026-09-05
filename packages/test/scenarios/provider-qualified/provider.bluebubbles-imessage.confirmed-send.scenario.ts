/** Defines the operator-manifest-gated BlueBubbles iMessage send canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.bluebubbles-imessage.confirmed-send",
  title: "Provider-qualified BlueBubbles iMessage send canary",
  provider: "bluebubbles",
  connectorProvider: "bluebubbles",
  operation: "message-send",
  plugins: [
    "@elizaos/plugin-personal-assistant",
    "@elizaos/plugin-bluebubbles",
  ],
  effectLabel: "iMessage send",
  targetLabel: "BlueBubbles canary chat",
  payload: "iMessage provider canary delivery",
});
