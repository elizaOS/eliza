import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "delegation-map-status-compression",
  title: "Assistant builds a delegation map and compresses status for review",
  domain: "executive.delegation",
  tags: ["lifeops", "executive-assistant", "prioritize", "followup"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Delegation Map Status Compression",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-delegation-map",
      text: "Map what I delegated this week across email, chat, and calendar notes. Group it by owner, due date, and whether I owe a reply.",
      plannerIncludesAny: ["BRIEF", "PRIORITIZE", "delegated", "owner"],
      responseIncludesAny: ["owner", "due", "reply", "delegated"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "compress-status-review",
      text: "Compress it into a five-line status review and create follow-ups only for items blocked on someone else.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "blocked", "status"],
      responseIncludesAny: ["status", "blocked", "follow"],
      plannerExcludes: ["owner_send_message"],
    },
  ],
});
