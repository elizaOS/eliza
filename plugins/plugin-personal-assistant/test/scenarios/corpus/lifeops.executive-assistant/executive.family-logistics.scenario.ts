/** Scenario fixture for executive family logistics; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "executive.family-logistics",
  title:
    "Family logistics reconciles appointments, rides, forms, and reminders",
  domain: "lifeops.executive-assistant",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "executive-assistant", "family", "personal-admin"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Family logistics",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "family-logistics",
      room: "main",
      text: "Check family logistics for the next 72 hours: appointments, school forms, rides, pickups, medications, and anything I need to confirm with another person.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "CALENDAR",
          "OWNER_DOCUMENTS",
          "MESSAGE",
          "OWNER_REMINDERS",
          "LIFE",
        ],
        description: "family logistics review",
        includesAny: [
          "appointment",
          "form",
          "ride",
          "pickup",
          "medication",
          "confirm",
        ],
      }),
      responseIncludesAny: [/appointment|pickup|ride|form|medication/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must reconcile family logistics into a small list of confirmations, reminders, and schedule risks.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "CALENDAR",
        "OWNER_DOCUMENTS",
        "MESSAGE",
        "OWNER_REMINDERS",
        "LIFE",
      ],
    },
    {
      type: "custom",
      name: "family-logistics-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "CALENDAR",
          "OWNER_DOCUMENTS",
          "MESSAGE",
          "OWNER_REMINDERS",
          "LIFE",
        ],
        description: "family logistics review",
        includesAny: [
          "appointment",
          "form",
          "ride",
          "pickup",
          "medication",
          "confirm",
        ],
      }),
    },
    judgeRubric({
      name: "executive-family-logistics-rubric",
      threshold: 0.7,
      description:
        "Agent coordinates family logistics without turning the response into a generic household checklist.",
    }),
  ],
});
