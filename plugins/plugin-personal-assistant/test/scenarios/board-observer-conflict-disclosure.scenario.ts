import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "board-observer-conflict-disclosure",
  title: "Assistant stages board observer conflict disclosure",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "approvals", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Observer Conflict Disclosure",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-conflict-materials",
      text: "A board observer may have a conflict on next week's financing item. Pull the agenda, observer rights, conflict policy, counsel thread, and disclosure deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "priority"],
      responseIncludesAny: ["agenda", "observer", "conflict", "deadline"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-disclosure-options",
      text: "Prepare disclosure options and a recusal logistics draft. Do not notify the observer or board until I approve the exact language.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["disclosure", "recusal", "observer", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
