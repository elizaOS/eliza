import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "minor-travel-consent-notarization",
  title: "Assistant coordinates minor travel consent notarization",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "family", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Minor Travel Consent Notarization",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-consent-requirements",
      text: "My child is traveling with another family. Gather consent letter requirements, passport copy rules, notary options, itinerary, and emergency contacts.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["consent", "passport", "notary", "contacts"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-consent-packet",
      text: "Prepare the consent packet and parent handoff note. Ask before sharing passport data or scheduling a notary appointment.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["packet", "handoff", "passport", "notary"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
