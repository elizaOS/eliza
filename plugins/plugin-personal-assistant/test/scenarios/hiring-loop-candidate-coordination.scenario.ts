import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "hiring-loop-candidate-coordination",
  title: "Assistant coordinates candidate interviews across calendar and mail",
  domain: "executive.hiring",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Hiring Loop Candidate Coordination",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "coordinate-interview-loop",
      text: "Coordinate the final interview loop for Nina: find two 45-minute slots with product and engineering, draft the candidate email, and don't send yet.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "Nina"],
      responseIncludesAny: ["slots", "draft", "candidate", "approval"],
      plannerExcludes: ["OWNER_FINANCES"],
    },
    {
      kind: "message",
      name: "protect-interviewer-load",
      text: "Avoid putting two interviews back-to-back for the same interviewer and add a prep reminder ten minutes before each slot.",
      plannerIncludesAny: ["calendar_action", "OWNER_REMINDERS", "prep"],
      responseIncludesAny: ["back-to-back", "prep", "reminder"],
      plannerExcludes: ["owner_send_message"],
    },
  ],
});
