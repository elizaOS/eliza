import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.browser-portal.certify-blocked-resume",
  title: "Certify browser blocked-resume intervention handling",
  connector: "browser-portal",
  axis: "blocked-resume",
  description:
    "Connector certification for browser portal work that gets blocked and must resume with human help instead of silently failing or falsely claiming completion.",
  seed: [
    {
      type: "connectorStatus",
      connector: "browser-portal",
      provider: "Browser bridge",
      state: "blocked-resume",
    },
  ],
  turns: [
    {
      name: "browser-portal-blocked-resume",
      text: "Upload the file through the portal, and if the portal blocks the browser, ask me for help and resume after that instead of pretending it already finished.",
      responseIncludesAny: ["portal", "blocked", "help", "resume"],
      acceptedActions: ["COMPUTER_USE", "AUTOFILL"],
      includesAny: ["portal", "blocked", "help", "resume"],
    },
  ],
  finalChecks: [
    { type: "browserTaskNeedsHuman", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
