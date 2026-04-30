import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "calendar.dossier.prep-briefing",
  title: "Agent generates a meeting prep dossier for an upcoming event",
  domain: "calendar",
  tags: ["lifeops", "calendar", "briefing", "meeting-prep"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Calendar Dossier Prep",
    },
  ],
  seed: [
    {
      type: "calendarEvent",
      account: "test-owner",
      title: "3pm meeting with Alex",
      startIso: "{{now+3h}}",
      endIso: "{{now+3h}}",
      attendees: ["alex@example.com"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-dossier",
      text: "Give me the dossier for my 3pm meeting.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DOSSIER", "CALENDAR_ACTION"],
        description: "meeting dossier planning",
        includesAny: ["dossier", "meeting", "Alex", "3pm"],
      }),
      responseIncludesAny: ["alex", "dossier", "brief", "meeting", "3pm"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must provide a prep briefing for the seeded 3pm meeting with Alex and mention at least one useful prep detail such as attendee, time, agenda, or logistics.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DOSSIER", "CALENDAR_ACTION"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["DOSSIER", "CALENDAR_ACTION"],
      includesAny: ["dossier", "meeting", "Alex", "3pm"],
    },
    {
      type: "custom",
      name: "meeting-dossier-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DOSSIER", "CALENDAR_ACTION"],
        description: "meeting dossier planning",
        includesAny: ["dossier", "meeting", "Alex", "3pm"],
      }),
    },
    judgeRubric({
      name: "meeting-dossier-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant produced a real meeting-prep dossier for the 3pm meeting with Alex instead of a generic calendar acknowledgement.",
    }),
  ],
});
