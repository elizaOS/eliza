import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "board-meeting-prebrief-risk-register",
  title: "Assistant prepares a board prebrief with risk register and decisions",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Meeting Prebrief",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-board-prebrief",
      text: "Prep me for tomorrow's board meeting. Pull the agenda, last board notes, open decisions, and a risk register. Only show what changed.",
      plannerIncludesAny: ["BRIEF", "OWNER_DOCUMENTS", "CALENDAR"],
      responseIncludesAny: ["board", "risk", "decisions", "changed"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "turn-gaps-into-followups",
      text: "For missing metrics, create follow-ups with owners and mark anything investor-sensitive for my review.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "approval", "owner"],
      responseIncludesAny: ["follow", "owner", "review"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
