import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.google-drive-docs-sheets.certify-core",
  title: "Certify Google Drive, Docs, and Sheets document ops",
  connector: "google-drive-docs-sheets",
  axis: "core",
  description:
    "Connector certification for document fetch, upload, share, provenance, and degraded-auth intervention across Drive, Docs, and Sheets.",
  turns: [
    {
      name: "google-docs-core",
      text: "Fetch the shared doc, upload the updated sheet, and give me the Drive provenance or tell me if auth is degraded.",
      responseIncludesAny: ["drive", "doc", "sheet", "upload", "auth"],
      acceptedActions: ["COMPUTER_USE"],
      includesAny: ["drive", "doc", "sheet", "upload", "auth"],
    },
  ],
  finalChecks: [
    { type: "browserTaskCompleted", expected: true },
    { type: "uploadedAssetExists", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
