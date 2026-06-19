import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "nda-counterparty-redline-handoff",
  title: "Assistant stages NDA redline handoff",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "legal", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps NDA Counterparty Redline Handoff",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-nda-redline",
      text: "A counterparty sent NDA redlines before the deal call. Extract changed clauses, fallback positions, counsel owner, call time, and unresolved business terms.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "priority"],
      responseIncludesAny: ["clauses", "fallback", "counsel", "business terms"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-redline-handoff",
      text: "Prepare a counsel handoff and call prep brief. Do not accept language or send the redline until I approve.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["handoff", "brief", "accept", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
