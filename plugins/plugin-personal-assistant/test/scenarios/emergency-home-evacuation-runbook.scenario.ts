import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "emergency-home-evacuation-runbook",
  title: "Assistant assembles a household evacuation runbook from documents and calendars",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Emergency Home Evacuation Runbook",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-evacuation-runbook",
      text: "Wildfire risk is rising. Pull together the pet records, insurance policy, go-bag checklist, school pickup plan, and who is out of town this week.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "household"],
      responseIncludesAny: ["pets", "insurance", "school", "go-bag"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "assign-household-roles",
      text: "Turn that into roles for me, my partner, and the sitter, with a reminder ladder if nobody confirms by 6pm.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "delegation", "reminder"],
      responseIncludesAny: ["roles", "sitter", "6pm", "confirm"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
