/** Defines the operator-manifest-gated Google Calendar create canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.google-calendar.create",
  title: "Provider-qualified Google Calendar create canary",
  provider: "google-calendar",
  connectorProvider: "google",
  operation: "event-create",
  plugins: [
    "@elizaos/plugin-personal-assistant",
    "@elizaos/plugin-google-workspace",
  ],
  effectLabel: "calendar event create",
  targetLabel: "Google Calendar canary calendar",
  payload: "elizaOS provider canary event",
});
