/** Defines the operator-manifest-gated Duffel travel-booking canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.duffel-travel.booking",
  title: "Provider-qualified Duffel travel hold canary",
  provider: "duffel-travel",
  operation: "booking-hold-create",
  plugins: ["@elizaos/plugin-personal-assistant"],
  effectLabel: "refundable booking hold create",
  targetLabel: "Duffel operator canary itinerary",
  payload: "elizaOS provider canary hold",
});
