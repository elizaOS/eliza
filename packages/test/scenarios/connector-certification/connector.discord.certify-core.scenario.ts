import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.discord.certify-core",
  title: "Certify Discord inbound and reply delivery",
  connector: "discord",
  axis: "core",
  roomSource: "discord",
  description:
    "Connector certification for Discord inbound fetch, draft/reply flows, thread context, and delivered outbound messages.",
  turns: [
    {
      name: "discord-core",
      text: "Read the Discord thread, draft a reply, and send it back in the right context.",
      responseIncludesAny: ["discord", "reply", "thread", "draft"],
      acceptedActions: ["MESSAGE", "MESSAGE"],
      includesAny: ["discord", "reply", "thread", "draft"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "discord", expected: true },
    { type: "messageDelivered", channel: "discord", expected: true },
  ],
});
