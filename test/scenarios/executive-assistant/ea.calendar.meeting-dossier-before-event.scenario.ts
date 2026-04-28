import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.calendar.meeting-dossier-before-event",
  title: "Generate a dossier before the next meeting or event",
  domain: "executive-assistant",
  tags: ["executive-assistant", "calendar", "briefing", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant should provide a prep dossier with people, context, and logistics before the meeting.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Meeting Dossier",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-dossier",
      room: "main",
      text: "Give me the dossier for my next meeting or event.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DOSSIER", "CALENDAR_ACTION"],
        description: "meeting dossier planning",
        includesAny: ["meeting", "event", "brief", "dossier"],
      }),
      responseIncludesAny: ["dossier", "meeting", "event", "brief", "context"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must contain a dossier-style brief that names the next meeting or event and references at least one of attendees, agenda, location, or supporting context. A bare acknowledgement that does not surface the prep material fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DOSSIER", "CALENDAR_ACTION"],
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
      name: "ea-meeting-dossier-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DOSSIER", "CALENDAR_ACTION"],
        description: "meeting dossier planning",
        includesAny: ["meeting", "event", "brief", "dossier"],
      }),
    },
    {
      type: "custom",
      name: "ea-meeting-dossier-memory-write",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description:
          "dossier output is persisted so the user can reference it later in the same room",
      }),
    },
    {
      type: "custom",
      name: "ea-meeting-dossier-dashboard-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["dashboard", "desktop"],
        description: "dossier delivered to the requesting surface",
      }),
    },
    judgeRubric({
      name: "ea-meeting-dossier-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant produced a usable dossier with people, agenda, and logistics for the next event. The dossier was delivered on the requesting channel and is available for follow-up via memory.",
    }),
  ],
});
