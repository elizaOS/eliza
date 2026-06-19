import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "board-packet-correction-sweep",
  title: "Assistant corrects a board packet after a late finance change",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "briefing", "approval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Packet Correction Sweep",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "identify-stale-packet-pages",
      text: "Finance changed the forecast after the board packet went out. Identify stale pages, affected recipients, counsel review need, and whether calendar prep needs an update.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "briefing"],
      responseIncludesAny: ["forecast", "recipients", "counsel", "calendar"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-correction-release",
      text: "Draft the correction note and resend plan. Ask for my approval before sending any updated packet.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["correction", "resend", "approval", "packet"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
