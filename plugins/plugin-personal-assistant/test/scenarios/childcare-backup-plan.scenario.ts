import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "childcare-backup-plan",
  title: "Assistant builds a backup childcare plan around work commitments",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "calendar"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Childcare Backup Plan",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "detect-childcare-gap",
      text: "Childcare fell through next Wednesday afternoon. Find my immovable work commitments and propose a backup plan.",
      plannerIncludesAny: ["CALENDAR", "CONFLICT_DETECT", "PRIORITIZE"],
      responseIncludesAny: ["Wednesday", "backup", "commitments"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-family-coordination",
      text: "Draft messages to the family thread and my assistant, but keep school pickup details private unless I approve.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["draft", "pickup", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
