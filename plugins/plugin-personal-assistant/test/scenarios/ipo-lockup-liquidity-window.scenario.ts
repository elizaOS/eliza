import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "ipo-lockup-liquidity-window",
  title: "Assistant coordinates IPO lockup liquidity planning",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "legal", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps IPO Lockup Liquidity Window",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-liquidity-window",
      text: "The lockup window opens soon. Gather blackout dates, 10b5-1 plan status, advisor availability, tax estimates, and charitable pledge timing.",
      plannerIncludesAny: ["OWNER_FINANCES", "calendar_action", "OWNER_DOCUMENTS"],
      responseIncludesAny: ["blackout", "10b5-1", "tax", "pledge"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-liquidity-approval",
      text: "Prepare a decision memo for counsel and wealth advisor. Do not authorize any trade, transfer, or pledge until I approve the plan.",
      plannerIncludesAny: ["owner_send_message", "approval", "OWNER_FINANCES"],
      responseIncludesAny: ["counsel", "advisor", "trade", "approve"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
