/** Defines the operator-manifest-gated Slack send canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.slack.confirmed-send",
  title: "Provider-qualified Slack confirmed-send canary",
  provider: "slack",
  connectorProvider: "slack",
  operation: "message-send",
  plugins: ["@elizaos/plugin-slack"],
  effectLabel: "message send",
  targetLabel: "private Slack canary channel",
  payload: "Slack provider canary delivery",
});
