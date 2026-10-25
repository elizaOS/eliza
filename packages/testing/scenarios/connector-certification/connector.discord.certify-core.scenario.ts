/** Scenario fixture for connector discord certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // Completion-state tokens the prompt never uses; parroting the request
      // ("draft a reply, send it") cannot satisfy any of them.
      responseIncludesAny: ["drafted", "sent", "delivered", "posted"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["discord", "reply", "thread", "draft"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "discord", expected: true },
    { type: "messageDelivered", channel: "discord", expected: true },
  ],
});
