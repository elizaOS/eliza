/**
 * Multi-turn memory: the agent is told a fact, then asked about it on a
 * later turn. The response to turn 2 must recall the fact from turn 1.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "cross.multi-turn.memory-across-turns",
  title: "Agent recalls a user-stated fact on a later turn",
  domain: "cross-cutting",
  tags: ["cross-cutting", "multi-turn", "critical"],
  description:
    "Turn 1 tells the agent the user's favorite color. Turn 2 asks what it is. The agent's response must contain 'blue'.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: memory across turns",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "state-fact",
      room: "main",
      text: "Please remember this fact for later: my favorite color is blue. Just acknowledge, don't update any profile fields.",
    },
    {
      kind: "message",
      name: "recall-fact",
      room: "main",
      text: "A moment ago I told you my favorite color. What color did I say? Please reply with the color name.",
      responseIncludesAny: ["blue", "Blue", "BLUE"],
    },
  ],

  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 2,
    },
  ],
});
