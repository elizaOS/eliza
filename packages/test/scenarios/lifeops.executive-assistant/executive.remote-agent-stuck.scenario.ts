import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.remote-agent-stuck",
  title: "Remote agent stuck flow escalates with context and owner choices",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "remote", "escalation"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Remote stuck",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "remote-stuck",
      room: "main",
      text: "The remote agent is stuck on a portal step. Summarize what it tried, what credential or CAPTCHA is blocking it, and give me choices: take over, approve a call, or retry later.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "REMOTE_DESKTOP",
          "WORK_THREAD",
          "VOICE_CALL",
          "MESSAGE",
          "LIFE",
        ],
        description: "remote stuck escalation",
        includesAny: [
          "stuck",
          "portal",
          "credential",
          "CAPTCHA",
          "take over",
          "retry",
        ],
      }),
      responseIncludesAny: [
        /stuck|portal|CAPTCHA|credential/i,
        /take over|call|retry/i,
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must summarize attempted work, name the blocker, and offer owner choices without exposing secrets.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "REMOTE_DESKTOP",
        "WORK_THREAD",
        "VOICE_CALL",
        "MESSAGE",
        "LIFE",
      ],
    },
    {
      type: "custom",
      name: "remote-stuck-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "REMOTE_DESKTOP",
          "WORK_THREAD",
          "VOICE_CALL",
          "MESSAGE",
          "LIFE",
        ],
        description: "remote stuck escalation",
        includesAny: [
          "stuck",
          "portal",
          "credential",
          "CAPTCHA",
          "take over",
          "retry",
        ],
      }),
    },
    judgeRubric({
      name: "executive-remote-stuck-rubric",
      threshold: 0.7,
      description:
        "Agent escalates blocked remote work with useful context and explicit owner options.",
    }),
  ],
});
