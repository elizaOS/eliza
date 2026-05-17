import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "remote.agent-calls-for-help",
  title: "Agent escalates to user via phone call when stuck",
  domain: "remote",
  tags: ["remote", "escalation", "retry-after-failure-edge"],
  description:
    "When the assistant is blocked in a remote/browser workflow, it should escalate via a real phone call or intervention channel instead of silently retrying or pretending success.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote Agent Calls For Help",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "agent-stuck",
      room: "main",
      text: "If you get stuck in a remote task or browser workflow, call me for help instead of looping.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "stuck remote-agent escalation",
        includesAny: ["call", "stuck", "remote", "browser", "help"],
      }),
      responseIncludesAny: ["call", "phone", "stuck", "help", "unblock"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to escalating via a real phone/voice help path when remote automation gets stuck, not by silently retrying forever.",
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
      name: "remote-agent-calls-for-help-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "stuck remote-agent escalation",
        includesAny: ["call", "stuck", "remote", "browser", "help"],
      }),
    },
    {
      type: "custom",
      name: "remote-agent-calls-for-help-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description:
          "stuck-agent escalation reaches the phone dispatcher instead of staying as a silent internal note",
      }),
    },
    judgeRubric({
      name: "remote-agent-calls-for-help-rubric",
      threshold: 0.7,
      description:
        "End-to-end: when the assistant gets blocked in remote work, it escalates through a real phone-call intervention path instead of larping completion.",
    }),
  ],
});
