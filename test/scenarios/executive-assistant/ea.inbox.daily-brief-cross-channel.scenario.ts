import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.inbox.daily-brief-cross-channel",
  title:
    "Build a daily brief with actions, schedule, unread channels, follow-ups, and docs",
  domain: "executive-assistant",
  tags: ["executive-assistant", "briefing", "messaging", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant produces a structured morning brief with actions first, today's schedule, unread items grouped by channel, overdue follow-ups, and document blockers surfaced from real inbox state.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Daily Brief Cross Channel",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-daily-brief",
      room: "main",
      text: "Give me the daily brief with these sections in order: Actions First, Today's Schedule, Unread By Channel, Overdue Follow-Ups, Documents And Forms. Use my connected inbox and calendar plus the recent cross-channel context already in scope.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "MESSAGE", "RELATIONSHIP"],
        description: "strict cross-channel morning brief generation",
        includesAny: [
          "brief",
          "actions",
          "schedule",
          "unread",
          "follow-up",
          "document",
        ],
      }),
      responseIncludesAny: [
        "Actions First",
        "Today's Schedule",
        "Unread By Channel",
        "Overdue Follow-Ups",
        "Documents And Forms",
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must be a structured morning brief with ordered sections for actions first, schedule, unread by channel, overdue follow-ups, and documents/forms. It must name concrete seeded items from at least two channels and at least one follow-up or document blocker. A generic summary blob fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["MESSAGE", "CALENDAR", "MESSAGE", "RELATIONSHIP"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["MESSAGE", "CALENDAR", "MESSAGE", "RELATIONSHIP"],
      includesAny: [
        "brief",
        "actions",
        "schedule",
        "unread",
        "follow",
        "document",
      ],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["dashboard", "desktop"],
    },
    {
      type: "custom",
      name: "ea-daily-brief-cross-channel-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE", "CALENDAR", "MESSAGE", "RELATIONSHIP"],
        description: "strict cross-channel morning brief generation",
        includesAny: [
          "brief",
          "actions",
          "schedule",
          "unread",
          "follow",
          "document",
        ],
      }),
    },
    {
      type: "custom",
      name: "ea-daily-brief-memory-write",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description:
          "brief output is persisted so the next turn can reference it",
      }),
    },
    {
      type: "custom",
      name: "ea-daily-brief-delivery-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["dashboard", "desktop"],
        description:
          "brief is delivered on the dashboard/desktop surface where it was requested",
      }),
    },
    judgeRubric({
      name: "ea-daily-brief-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant produced an ordered morning brief covering actions first, today's schedule, unread-by-channel context, overdue follow-ups, and document blockers from real seeded state across multiple channels.",
    }),
  ],
});
