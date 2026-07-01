import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.slack.certify-core",
  title: "Certify Slack inbound and reply delivery",
  connector: "slack",
  axis: "core",
  roomSource: "slack",
  description:
    "Connector certification for Slack inbound fetch, draft/reply flows, thread context, and delivered outbound messages.",
  turns: [
    {
      name: "slack-core",
      text: "Read the Slack thread, draft a reply, and send it back in the right channel/thread.",
      responseIncludesAny: ["slack", "reply", "thread", "draft"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["slack", "reply", "thread", "draft"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "slack", expected: true },
    { type: "messageDelivered", channel: "slack", expected: true },
  ],
});
