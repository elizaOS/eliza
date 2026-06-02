import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.end-of-day-closeout",
  title: "End-of-day closeout compresses unresolved decisions and tomorrow risks",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "closeout", "chat-first"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Closeout" },
  ],
  turns: [
    {
      kind: "message",
      name: "closeout",
      room: "main",
      text: "Run end-of-day closeout: unresolved decisions, tomorrow risks, waiting-on items, promises I made today, and tasks worth moving. Keep it tight.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BRIEF", "LIFE", "INBOX", "MESSAGE", "CALENDAR", "RELATIONSHIP"],
        description: "end-of-day closeout",
        includesAny: ["unresolved", "tomorrow", "waiting", "promises", "tasks"],
      }),
      responseIncludesAny: [/decision|tomorrow|waiting|promise|task/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should be a tight closeout brief with unresolved decisions, tomorrow risks, waiting-on items, promises, and movable tasks.",
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: ["BRIEF", "LIFE", "INBOX", "MESSAGE", "CALENDAR", "RELATIONSHIP"] },
    {
      type: "custom",
      name: "closeout-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BRIEF", "LIFE", "INBOX", "MESSAGE", "CALENDAR", "RELATIONSHIP"],
        description: "end-of-day closeout",
        includesAny: ["unresolved", "tomorrow", "waiting", "promises", "tasks"],
      }),
    },
    judgeRubric({
      name: "executive-closeout-rubric",
      threshold: 0.7,
      description:
        "Agent provides a compact end-of-day closeout, optimized for what the user must decide or move.",
    }),
  ],
});
