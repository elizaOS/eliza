/** Scenario fixture for connector google drive docs sheets certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.google-drive-docs-sheets.certify-core",
  title: "Certify Google Drive, Docs, and Sheets document ops",
  connector: "google-drive-docs-sheets",
  axis: "core",
  description:
    "Connector certification for document fetch, upload, share, provenance, and degraded-auth intervention across Drive, Docs, and Sheets.",
  turns: [
    {
      name: "google-docs-core",
      text: "Fetch the shared doc and push the updated sheet up to Drive, then show me exactly where it landed and how you got it there.",
      // Derived-output tokens: a real completion reports the uploaded artifact
      // and its provenance; none of these appear in the prompt text.
      responseIncludesAny: ["uploaded", "provenance", "version", "revision"],
      expectedActions: ["COMPUTER_USE"],
      actionPayloadIncludesAny: ["drive", "doc", "sheet", "upload", "auth"],
    },
  ],
  finalChecks: [
    { type: "browserTaskCompleted", expected: true },
    { type: "uploadedAssetExists", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
