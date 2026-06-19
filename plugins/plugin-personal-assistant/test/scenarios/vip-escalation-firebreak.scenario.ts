import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "vip-escalation-firebreak",
  title: "Assistant protects focus while escalating a true VIP interruption",
  domain: "executive.escalation",
  tags: ["lifeops", "executive-assistant", "prioritize", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps VIP Escalation Firebreak",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "classify-vip-vs-noise",
      text: "I'm in deep work for two hours. Watch messages and only interrupt me if Clara, the board chair, or legal needs a same-day decision.",
      plannerIncludesAll: ["PRIORITIZE", "SCHEDULED_TASKS"],
      plannerIncludesAny: ["vip", "interrupt", "same-day", "legal"],
      responseIncludesAny: ["watch", "interrupt", "Clara", "legal"],
      plannerExcludes: ["owner_send_message", "calendar_action"],
    },
    {
      kind: "message",
      name: "escalate-confirmed-vip",
      text: "Legal just sent a redline deadline for tonight; draft the shortest interruption summary and ask me for the decision.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "RESOLVE_REQUEST", "legal"],
      responseIncludesAny: ["redline", "decision", "summary", "tonight"],
      plannerExcludes: ["send_to_agent", "list_agents"],
    },
  ],
});
