import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.vip-escalation",
  title: "VIP escalation chooses the right channel and urgency",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "vip", "escalation"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "VIP escalation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vip-escalation",
      room: "main",
      text: "A VIP investor asked for a decision while I'm in meetings. Decide whether to DM, email, SMS, call me, or wait; include why and avoid over-escalating.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "MESSAGE",
          "VOICE_CALL",
          "INBOX",
          "RELATIONSHIP",
          "LIFE",
        ],
        description: "VIP channel escalation",
        includesAny: ["VIP", "investor", "DM", "email", "SMS", "call", "wait"],
      }),
      responseIncludesAny: [/VIP|investor/i, /DM|email|SMS|call|wait/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must choose a channel and urgency posture with reasoning, while avoiding unnecessary escalation.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "VOICE_CALL", "INBOX", "RELATIONSHIP", "LIFE"],
    },
    {
      type: "custom",
      name: "vip-escalation-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "MESSAGE",
          "VOICE_CALL",
          "INBOX",
          "RELATIONSHIP",
          "LIFE",
        ],
        description: "VIP channel escalation",
        includesAny: ["VIP", "investor", "DM", "email", "SMS", "call", "wait"],
      }),
    },
    judgeRubric({
      name: "executive-vip-escalation-rubric",
      threshold: 0.7,
      description:
        "Agent routes a VIP decision through the appropriate channel without reflexively interrupting the owner.",
    }),
  ],
});
