import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "succession-comms-holdback",
  title: "Assistant stages succession communications with holdbacks",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "privacy", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Succession Comms Holdback",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-succession-audiences",
      text: "Build the succession comms plan: board, employees, key customers, family office, press holdback, and who needs legal review before any draft moves.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["board", "customers", "holdback", "legal review"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-succession-drafts",
      text: "Draft audience-specific notes, but keep the press version withheld and ask before sending anything to employees or customers.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["press", "withheld", "employees", "customers"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
