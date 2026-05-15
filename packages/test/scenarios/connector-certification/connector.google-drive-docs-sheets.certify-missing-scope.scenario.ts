import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.google-drive-docs-sheets.certify-missing-scope",
  title: "Certify Drive and Docs missing-scope degradation handling",
  connector: "google-drive-docs-sheets",
  axis: "missing-scope",
  description:
    "Connector certification for Drive, Docs, and Sheets when upload or share scope is missing. The assistant must surface the missing scope and request intervention instead of pretending the artifact was uploaded.",
  seed: [
    {
      type: "connectorStatus",
      connector: "google-drive-docs-sheets",
      provider: "Google Drive API",
      state: "missing-scope",
      capabilities: ["google.calendar.read"],
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    },
  ],
  turns: [
    {
      name: "google-docs-missing-scope",
      text: "Fetch the shared doc and upload the updated sheet, but if Drive write scope is missing, tell me exactly that and ask for re-auth instead of claiming the upload finished.",
      responseIncludesAny: ["drive", "missing", "scope", "upload"],
      acceptedActions: ["COMPUTER_USE"],
      includesAny: ["drive", "missing", "scope", "upload"],
    },
  ],
  finalChecks: [{ type: "interventionRequestExists", expected: true }],
});
