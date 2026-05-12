import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.schedule.protect-sleep-window",
  title: "Protect sleep window unless the user explicitly overrides it",
  domain: "executive-assistant",
  tags: [
    "executive-assistant",
    "calendar",
    "preferences",
    "transcript-derived",
  ],
  description:
    "Transcript-derived case: the assistant checks whether a meeting is allowed inside a protected sleep block.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Sleep Window Protection",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "sleep-window-preference",
      room: "main",
      text: "No calls between 11pm and 8am unless I explicitly say it's okay.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "sleep-window preference capture",
        includesAny: ["11pm", "8am", "sleep", "calls"],
      }),
      responseIncludesAny: ["11pm", "8am", "sleep", "protect", "explicitly"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must record a 23:00–08:00 sleep block as a protected preference and confirm explicit-override semantics. A generic 'noted' without storing the rule fails.",
      },
    },
    {
      kind: "message",
      name: "request-early-call",
      room: "main",
      text: "Can you schedule a 7am call tomorrow, or should we move it?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "sleep-window conflict resolution",
        includesAny: ["7am", "move", "sleep", "override"],
      }),
      responseIncludesAny: ["7am", "sleep", "okay", "move", "override"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface the sleep-window conflict (07:00 falls inside the 23:00–08:00 protected block) and either ask for an explicit override or propose moving the call. Silently scheduling fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "CALENDAR",
        "CALENDAR",
        "CALENDAR",
      ],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "ea-protect-sleep-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "CALENDAR",
          "CALENDAR",
          "CALENDAR",
        ],
        description: "sleep-window preference capture and conflict resolution",
        includesAny: ["11pm", "8am", "sleep", "7am", "move"],
      }),
    },
    {
      type: "custom",
      name: "ea-protect-sleep-preference-memory",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "sleep-window preference is persisted",
        contentIncludesAny: ["sleep", "11pm", "8am"],
      }),
    },
    judgeRubric({
      name: "ea-protect-sleep-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant captured the sleep-window preference, then on the second turn correctly flagged the 7am call as a conflict and required explicit override or a move.",
    }),
  ],
});
