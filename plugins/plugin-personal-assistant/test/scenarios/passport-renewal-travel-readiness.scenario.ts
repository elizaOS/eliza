import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "passport-renewal-travel-readiness",
  title: "Assistant catches passport risk before international travel",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "legal"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Passport Travel Readiness",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "audit-passport-risk",
      text: "Before the Singapore trip, check whether my passport, visa, calendar holds, and hotel details are safe. Flag anything that could block boarding.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "CALENDAR", "travel"],
      responseIncludesAny: ["passport", "visa", "boarding", "Singapore"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "build-renewal-plan",
      text: "If the passport window is risky, create the renewal task list and draft the note to the travel coordinator.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "owner_send_message", "renewal"],
      responseIncludesAny: ["renewal", "task", "draft"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
