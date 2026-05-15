import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.snooze-until-monday",
  title: "Snooze a follow-up until Monday morning and confirm the wake time",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "snooze", "scheduling"],
  description:
    "User says 'snooze until Monday'. Agent must store an explicit wake time (Monday 9am local), not a vague 'I'll get back to it'. The wake time must be in the structured payload.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Snooze until Monday",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "snooze-monday",
      room: "main",
      text: "Snooze the partner intro follow-up until Monday morning at 9am. I don't want to think about it before then.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["LIFE", "INBOX"],
        description: "snooze with explicit wake time",
        includesAny: ["Monday", "9am", "snooze", "partner intro"],
      }),
      responseIncludesAny: ["Monday", "9am", "snooze"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm a snooze until Monday 9am specifically — explicit wake time. 'Got it' without naming Monday/9am fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["LIFE", "INBOX"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["LIFE", "INBOX"],
      includesAny: ["Monday", "9am", "snooze"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "followup-snooze-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["LIFE", "INBOX"],
        description: "snooze with explicit wake",
      }),
    },
    {
      type: "custom",
      name: "followup-snooze-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "snooze wake time persisted",
        contentIncludesAny: ["Monday", "9am", "snooze"],
      }),
    },
    judgeRubric({
      name: "followup-snooze-rubric",
      threshold: 0.7,
      description:
        "Snooze stored with concrete Monday 9am wake time, not vague.",
    }),
  ],
});
