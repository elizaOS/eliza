import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "confidential-recruiting-reference-check",
  title: "Assistant runs confidential executive recruiting reference checks",
  domain: "executive.hiring",
  tags: ["lifeops", "executive-assistant", "hiring", "privacy", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Confidential Recruiting Reference Check",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "coordinate-reference-windows",
      text: "For the CFO candidate, schedule discreet reference calls, avoid the candidate's current employer, collect conflict notes, and prepare a decision memo.",
      plannerIncludesAny: ["calendar_action", "privacy", "OWNER_DOCUMENTS"],
      responseIncludesAny: ["reference", "employer", "conflict", "memo"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-reference-outreach",
      text: "Draft outreach to approved references only and a separate update for the hiring lead. Keep candidate identity limited to need-to-know recipients.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["references", "hiring lead", "identity", "need-to-know"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
