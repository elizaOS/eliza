import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.outage-recovery",
  title: "Outage recovery degrades across unavailable connectors",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "resilience", "connectors"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Outage recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "outage-recovery",
      room: "main",
      text: "If Gmail and Signal are degraded, recover my command brief from calendar, Discord, local reminders, docs, and cached context. Tell me exactly what is missing.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "BRIEF",
          "CALENDAR",
          "MESSAGE",
          "OWNER_DOCUMENTS",
          "LIFE",
          "CONNECTOR",
        ],
        description: "degraded connector command brief",
        includesAny: ["Gmail", "Signal", "degraded", "missing", "cached"],
      }),
      responseIncludesAny: [
        /degraded|missing|cached/i,
        /calendar|Discord|docs|reminders/i,
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must continue with available sources, identify unavailable connectors, and state confidence or missing data.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "BRIEF",
        "CALENDAR",
        "MESSAGE",
        "OWNER_DOCUMENTS",
        "LIFE",
        "CONNECTOR",
      ],
    },
    {
      type: "custom",
      name: "outage-recovery-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "BRIEF",
          "CALENDAR",
          "MESSAGE",
          "OWNER_DOCUMENTS",
          "LIFE",
          "CONNECTOR",
        ],
        description: "degraded connector command brief",
        includesAny: ["Gmail", "Signal", "degraded", "missing", "cached"],
      }),
    },
    judgeRubric({
      name: "executive-outage-recovery-rubric",
      threshold: 0.7,
      description:
        "Agent degrades gracefully and does useful work from remaining sources instead of failing the whole brief.",
    }),
  ],
});
