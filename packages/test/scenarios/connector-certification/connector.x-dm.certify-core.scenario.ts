import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.x-dm.certify-core",
  title: "Certify X DM inbox reads and response drafting",
  connector: "x-dm",
  axis: "core",
  description:
    "Connector certification for X DM reads, response drafting, and message-context handling through the X surface.",
  turns: [
    {
      name: "x-dm-core",
      text: "Read my unread X DMs and draft the right reply with the right context.",
      responseIncludesAny: ["x", "dm", "reply", "draft"],
      acceptedActions: ["X_READ", "INBOX"],
      includesAny: ["x", "dm", "reply", "draft"],
    },
  ],
  finalChecks: [{ type: "draftExists", channel: "x-dm", expected: true }],
});
