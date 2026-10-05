/** Scenario fixture for connector telegram certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.telegram.certify-core",
  title: "Certify Telegram inbound and reply delivery",
  connector: "telegram",
  axis: "core",
  roomSource: "telegram",
  description:
    "Connector certification for Telegram inbound fetch, draft/reply flows, thread context, and delivered outbound messages.",
  turns: [
    {
      name: "telegram-core",
      text: "Read the Telegram chat, draft a reply, and send it back in the same chat.",
      // Completion-state tokens the prompt never uses; parroting "draft a
      // reply, send it" cannot satisfy any of them.
      responseIncludesAny: ["drafted", "sent", "delivered", "replied"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["telegram", "reply", "chat", "draft"],
    },
  ],
  finalChecks: [
    { type: "draftExists", channel: "telegram", expected: true },
    { type: "messageDelivered", channel: "telegram", expected: true },
  ],
});
