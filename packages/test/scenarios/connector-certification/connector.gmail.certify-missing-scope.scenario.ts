import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.gmail.certify-missing-scope",
  title: "Certify Gmail missing-scope degradation handling",
  connector: "gmail",
  axis: "missing-scope",
  description:
    "Connector certification for Gmail degraded auth when send scope is missing. The assistant must surface the missing scope explicitly and hold a draft instead of pretending the reply was sent.",
  seed: [
    {
      type: "connectorStatus",
      connector: "gmail",
      provider: "Gmail API",
      state: "missing-scope",
      capabilities: ["google.gmail.triage"],
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
  ],
  turns: [
    {
      name: "gmail-missing-scope",
      text: "Read Sarah Lee's unread Gmail thread and prepare the reply, but if Gmail send access is missing, tell me exactly that and ask for the reconnect or scope upgrade instead of claiming it was sent.",
      responseIncludesAny: ["gmail", "missing", "scope", "reconnect"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["gmail", "missing", "scope", "reconnect"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "gmail", expected: true },
    { type: "interventionRequestExists", expected: true },
  ],
});
