/** Scenario fixture for executive event planning; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "executive.event-planning",
  title: "Event planning coordinates calendar, invites, venue, docs, and tasks",
  domain: "lifeops.executive-assistant",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "executive-assistant", "events", "calendar"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Event planning",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "event-plan",
      room: "main",
      text: "Prep the customer dinner event: calendar holds, invite list, venue confirmation, menu docs, travel buffers, and delegated follow-ups.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "MESSAGE", "OWNER_DOCUMENTS", "LIFE"],
        description: "event planning coordination",
        includesAny: ["event", "calendar", "invite", "venue", "follow-ups"],
      }),
      responseIncludesAny: [/event|dinner/i, /calendar|invite|venue|follow/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should coordinate event logistics across calendar, invites, venue, documents, travel buffers, and delegated follow-ups.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "MESSAGE", "OWNER_DOCUMENTS", "LIFE"],
    },
    {
      type: "custom",
      name: "event-planning-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "MESSAGE", "OWNER_DOCUMENTS", "LIFE"],
        description: "event planning coordination",
        includesAny: ["event", "calendar", "invite", "venue", "follow-ups"],
      }),
    },
    judgeRubric({
      name: "executive-event-planning-rubric",
      threshold: 0.7,
      description:
        "Agent turns event planning into concrete logistics checks and tasks.",
    }),
  ],
});
