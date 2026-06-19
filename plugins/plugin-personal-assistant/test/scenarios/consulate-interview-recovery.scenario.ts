import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "consulate-interview-recovery",
  title: "Assistant recovers a missed consulate interview slot",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "documents", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Consulate Interview Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-consulate-recovery",
      text: "We missed the consulate interview slot. Build a recovery plan: appointment portal options, passport location, invitation letter, travel dates at risk, and escalation contacts.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "travel"],
      responseIncludesAny: ["portal", "passport", "travel dates", "escalation"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-consulate-outreach",
      text: "Draft outreach to the consulate and travel desk, but ask me before sending or paying any expedited service fee.",
      plannerIncludesAny: ["owner_send_message", "approval", "OWNER_FINANCES"],
      responseIncludesAny: ["consulate", "travel desk", "sending", "fee"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
