import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "browser.computer-use.agent-fails-calls-user-for-help",
  title: "Agent escalates failed browser action to user",
  domain: "browser.lifeops",
  tags: ["browser", "computer-use", "escalation", "failure"],
  description:
    "When browser/computer-use automation fails, the assistant should escalate through a real intervention or phone path instead of silently retrying or fabricating success.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Computer-use: failure escalation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "failure-escalation",
      room: "main",
      text: "If that browser task gets stuck on auth or page layout issues, call me for help instead of pretending it worked.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "failed browser-task escalation",
        includesAny: ["call", "browser", "stuck", "auth", "layout"],
      }),
      responseIncludesAny: ["call", "stuck", "help", "browser", "unblock"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface the browser-task failure mode clearly and commit to escalating through a real intervention path rather than pretending success.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["VOICE_CALL", "COMPUTER_USE"],
    },
    {
      type: "interventionRequestExists",
      expected: true,
    },
    {
      type: "pushSent",
      channel: "phone_call",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "phone_call",
      actionName: ["VOICE_CALL"],
    },
    {
      type: "custom",
      name: "browser-failure-escalation-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "failed browser-task escalation",
        includesAny: ["call", "browser", "stuck", "auth", "layout"],
      }),
    },
    {
      type: "custom",
      name: "browser-failure-escalation-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description:
          "failed browser automation escalates through the phone dispatcher",
      }),
    },
    judgeRubric({
      name: "browser-failure-escalation-rubric",
      threshold: 0.7,
      description:
        "End-to-end: failed browser automation escalated through a real call/intervention path instead of silently failing or fabricating completion.",
    }),
  ],
});
