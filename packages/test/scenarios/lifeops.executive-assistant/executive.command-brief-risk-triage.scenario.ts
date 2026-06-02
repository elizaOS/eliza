import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.command-brief-risk-triage",
  title: "Command brief compresses calendar, inbox, reminders, and decisions",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "command-brief", "chat-first"],
  description:
    "The assistant landing flow should produce a small decision brief across calendar, inbox, reminders, and blocked decisions instead of dumping every record.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Executive command brief",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "command-brief",
      room: "main",
      text: "Give me a LifeOps command brief: calendar risks, inbox decisions, reminders, and anything blocked. Keep it to the smallest useful set.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BRIEF", "LIFE", "INBOX", "MESSAGE", "CALENDAR"],
        description: "cross-domain command brief",
        includesAny: ["calendar", "inbox", "reminder", "blocked", "decision"],
      }),
      responseIncludesAny: [/calendar|meeting/i, /inbox|message|decision/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should be concise and decision-oriented. It must organize calendar risks, inbox decisions, reminders, and blocked items without long narrative or exhaustive record dumps.",
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: ["BRIEF", "LIFE", "INBOX", "MESSAGE", "CALENDAR"] },
    {
      type: "custom",
      name: "command-brief-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BRIEF", "LIFE", "INBOX", "MESSAGE", "CALENDAR"],
        description: "cross-domain command brief",
        includesAny: ["calendar", "inbox", "reminder", "blocked", "decision"],
      }),
    },
    judgeRubric({
      name: "executive-command-brief-rubric",
      threshold: 0.7,
      description:
        "Agent returns a compact command brief with risks and decisions, not a verbose dashboard substitute.",
    }),
  ],
});
