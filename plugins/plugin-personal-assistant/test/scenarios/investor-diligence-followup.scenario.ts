import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "investor-diligence-followup",
  title: "Assistant manages investor diligence follow-up",
  domain: "executive.followup",
  tags: ["lifeops", "executive-assistant", "followup", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Investor Diligence Follow-Up",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-diligence-asks",
      text: "Track investor diligence follow-ups: unanswered data requests, owner for each doc, redacted materials, promised timing, and open legal caveats.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "privacy"],
      responseIncludesAny: ["data requests", "redacted", "timing", "legal caveats"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-investor-followup",
      text: "Draft a follow-up note and escalation tracker, but hold anything containing redacted materials until legal approves.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["follow-up", "tracker", "redacted", "legal approves"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
