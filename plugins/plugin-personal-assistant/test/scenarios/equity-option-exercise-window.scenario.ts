import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "equity-option-exercise-window",
  title: "Assistant protects equity option exercise window",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "legal", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Equity Option Exercise Window",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-exercise-window",
      text: "Check whether any equity options have an exercise deadline this month. Pull grant docs, strike price, tax estimate, liquidity constraints, and broker steps.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["deadline", "strike", "tax", "broker"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-exercise-approval",
      text: "Prepare an exercise decision packet and advisor questions. Ask before initiating an exercise, wiring funds, or sharing grant details.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["decision packet", "advisor", "wiring", "grant"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
