import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "work-thread-handoff-recovery",
  title: "Assistant recovers a stalled work thread and prepares a handoff",
  domain: "executive.delegation",
  tags: ["lifeops", "executive-assistant", "work-thread", "delegation"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Work Thread Handoff Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "diagnose-stalled-thread",
      text: "The procurement work thread has stalled. Summarize owner, blocker, last real progress, and the next safe action.",
      plannerIncludesAny: ["WORK_THREAD", "PRIORITIZE", "blocker"],
      responseIncludesAny: ["owner", "blocker", "next"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "prepare-handoff",
      text: "Create a handoff for Sam with context, deadline, risks, and a follow-up check-in for Friday.",
      plannerIncludesAny: ["WORK_THREAD", "SCHEDULED_TASKS", "Friday"],
      responseIncludesAny: ["handoff", "Sam", "Friday"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
