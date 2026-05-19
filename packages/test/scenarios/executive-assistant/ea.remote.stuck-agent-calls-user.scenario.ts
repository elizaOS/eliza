import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.remote.stuck-agent-calls-user",
  title: "Call the user for help when the assistant gets stuck",
  domain: "executive-assistant",
  tags: ["executive-assistant", "remote", "escalation", "transcript-derived"],
  description:
    "Transcript-derived case: when browser or computer-use automation gets blocked, the assistant should escalate to the user instead of silently failing.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Remote Stuck Agent Calls User",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "remote-help-policy",
      room: "main",
      text: "If you get stuck in the browser or on my computer, call me and let me jump in to unblock it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "stuck-agent escalation",
        includesAny: ["call", "stuck", "browser", "computer", "unblock"],
      }),
      responseIncludesAny: ["call", "stuck", "browser", "computer", "unblock"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to escalating via a real call when browser/computer automation is blocked, not by silently retrying. The escalation channel must be named (phone/voice).",
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
      name: "ea-stuck-agent-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "stuck-agent escalation",
        includesAny: ["call", "stuck", "browser", "computer", "unblock"],
      }),
    },
    {
      type: "custom",
      name: "ea-stuck-agent-call-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description:
          "stuck-agent escalation goes through the voice/phone dispatcher",
      }),
    },
    judgeRubric({
      name: "ea-stuck-agent-rubric",
      threshold: 0.7,
      description:
        "End-to-end: when computer-use stalled, the assistant placed a real voice call escalation rather than silently failing or retrying forever.",
    }),
  ],
});
