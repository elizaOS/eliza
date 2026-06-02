import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "release-branch-war-room",
  title: "Assistant runs release branch war-room coordination",
  domain: "executive.delegation",
  tags: ["lifeops", "executive-assistant", "delegation", "briefing", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Release Branch War Room",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "compress-release-risks",
      text: "The release branch is stuck. Build a war-room brief from engineering threads, unresolved blockers, decision owners, customer impact, and rollback criteria.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "owner_send_message", "priority"],
      responseIncludesAny: ["blockers", "owners", "customer impact", "rollback"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "schedule-release-war-room",
      text: "Draft the war-room invite and owner checklist, then hold it for approval before sending to engineering leadership.",
      plannerIncludesAny: ["calendar_action", "approval", "owner_send_message"],
      responseIncludesAny: ["invite", "checklist", "approval", "leadership"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
