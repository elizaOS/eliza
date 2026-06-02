import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "executive-device-loss-response",
  title: "Assistant runs an executive device loss response",
  domain: "executive.privacy",
  tags: ["lifeops", "executive-assistant", "privacy", "security", "travel"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Executive Device Loss Response",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-lost-device",
      text: "My work phone may have been left in the hotel car. Build the response plan: driver contact, MDM lock status, account rotation list, and sensitive meetings on that device.",
      plannerIncludesAny: ["owner_send_message", "privacy", "calendar_action"],
      responseIncludesAny: ["driver", "MDM", "rotation", "meetings"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-security-notifications",
      text: "Draft notifications for security, assistant team, and the hotel, but do not claim the device is compromised until we have confirmation.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["security", "hotel", "compromised", "confirmation"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
