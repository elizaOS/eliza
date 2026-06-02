import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "private-aviation-crew-swap",
  title: "Assistant recovers private aviation crew logistics",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "vendor", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Private Aviation Crew Swap",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "recover-crew-swap",
      text: "The charter operator says the crew timed out. Find replacement crew options, passenger impact, airport slot constraints, and backup commercial route.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "travel"],
      responseIncludesAny: ["crew", "passenger", "slot", "backup"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "prepare-travel-decision",
      text: "Give me a decision memo with timing, cost delta, and who needs to be notified. Ask before confirming any aircraft or hotel change.",
      plannerIncludesAny: ["approval", "owner_send_message", "OWNER_FINANCES"],
      responseIncludesAny: ["decision", "cost", "notified", "confirming"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
