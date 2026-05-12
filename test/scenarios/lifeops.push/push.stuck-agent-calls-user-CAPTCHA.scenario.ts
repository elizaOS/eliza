import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.stuck-agent-calls-user-CAPTCHA",
  title: "Browser CAPTCHA blocks the agent — escalate via voice call",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "escalation", "captcha", "remote-help"],
  description:
    "Computer-use is doing a flight check-in, hits a CAPTCHA wall. Per the remote-help policy in PRD §Remote, the agent must call the user (not just send a passive notification) so they can complete the CAPTCHA in real time.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Stuck on CAPTCHA",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "browser-task-state",
        task: "United online check-in",
        blockedBy: "CAPTCHA",
        attempts: 2,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "stuck-captcha",
      room: "main",
      text: "Computer-use just hit a CAPTCHA on United check-in for the second time. Get help.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "CAPTCHA escalation via call",
        includesAny: ["call", "CAPTCHA", "United", "stuck"],
      }),
      responseIncludesAny: ["call", "CAPTCHA", "United"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must escalate via voice call (not silent retry, not desktop notification) so the user can solve CAPTCHA in real time.",
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
      name: "push-captcha-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL", "COMPUTER_USE"],
        description: "CAPTCHA escalation",
      }),
    },
    {
      type: "custom",
      name: "push-captcha-call-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description: "voice escalation dispatched for CAPTCHA",
      }),
    },
    judgeRubric({
      name: "push-captcha-rubric",
      threshold: 0.7,
      description:
        "Voice call escalation fired for CAPTCHA blocker — real-time remote help.",
    }),
  ],
});
