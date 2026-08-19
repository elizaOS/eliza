/** Defines the operator-manifest-gated Google Drive and Sheets create canary. */
import { buildProviderCanary } from "./_provider-canary-factory.ts";
export default buildProviderCanary({
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  id: "provider.google-sheets.create",
  title: "Provider-qualified Google Drive and Sheets create canary",
  provider: "google-sheets",
  operation: "spreadsheet-create",
  plugins: [
    "@elizaos/plugin-personal-assistant",
    "@elizaos/plugin-google-workspace",
  ],
  effectLabel: "spreadsheet create",
  targetLabel: "Google Drive canary folder",
  payload: "elizaOS provider canary sheet",
});
