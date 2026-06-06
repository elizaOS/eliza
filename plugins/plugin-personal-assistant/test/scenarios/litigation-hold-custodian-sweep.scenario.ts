import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "litigation-hold-custodian-sweep",
  title: "Assistant coordinates a litigation hold custodian sweep",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Litigation Hold Custodian Sweep",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-custodians-and-sources",
      text: "Outside counsel sent a litigation hold. Map likely custodians, shared drives, calendar ranges, messaging threads, and missing acknowledgements without opening privileged attachments.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "privacy", "delegation"],
      responseIncludesAny: ["custodians", "shared drives", "calendar", "acknowledgements"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-hold-followups",
      text: "Draft follow-ups for custodians who have not acknowledged and schedule a counsel check-in tomorrow. Do not send without my approval.",
      plannerIncludesAny: ["owner_send_message", "calendar_action", "approval"],
      responseIncludesAny: ["follow-ups", "custodians", "counsel", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
