import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "twilio.sms.send-from-agent-with-confirmation",
  title: "Agent sends outbound SMS via Twilio after confirmation",
  domain: "gateway",
  tags: ["gateway", "twilio", "sms", "confirms-destructive-edge"],
  description:
    "The assistant drafts a real Twilio SMS behind approval, then delivers it only after the user confirms.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twilio SMS Send With Confirmation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-send",
      room: "main",
      text: "Draft an SMS to +15555550101 saying I'll be late for dinner, but hold it for my approval.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "twilio sms draft",
        includesAny: ["sms", "draft", "confirm", "15555550101"],
      }),
      responseIncludesAny: ["confirm", "SMS", "draft", "late"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 1 must create a Twilio SMS draft and keep it unsent until approval.",
      },
    },
    {
      kind: "message",
      name: "confirm-send",
      room: "main",
      text: "Yes, send that SMS to +15555550101 now.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "twilio sms send confirmed",
        includesAny: ["sms", "send", "15555550101"],
      }),
      responseIncludesAny: ["sent", "delivered", "SMS", "text"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 2 must make clear that the confirmed Twilio SMS is now being sent.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
    },
    {
      type: "draftExists",
      channel: "sms",
      expected: true,
    },
    {
      type: "messageDelivered",
      channel: "sms",
      expected: true,
    },
    {
      type: "custom",
      name: "twilio-sms-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "twilio sms draft then send",
        includesAny: ["sms", "draft", "send", "15555550101"],
        minCount: 2,
      }),
    },
    judgeRubric({
      name: "twilio-sms-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant drafted the Twilio SMS first and only delivered it after explicit confirmation.",
    }),
  ],
});
