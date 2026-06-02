import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.home-ops",
  title: "Home ops review covers deliveries, errands, reservations, and support tickets",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "home-ops", "personal-admin"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Home ops" },
  ],
  turns: [
    {
      kind: "message",
      name: "home-ops-review",
      room: "main",
      text: "Review home ops: deliveries, maintenance, errands, appointments, reservations, gifts, support tickets, and household admin. Surface only what needs a decision.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["LIFE", "MESSAGE", "CALENDAR", "OWNER_DOCUMENTS"],
        description: "home operations decision review",
        includesAny: ["delivery", "maintenance", "errand", "appointment", "reservation", "support"],
      }),
      responseIncludesAny: [/delivery|maintenance|errand|appointment|reservation|support/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should be a decision-focused home ops review, not a generic chores list.",
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: ["LIFE", "MESSAGE", "CALENDAR", "OWNER_DOCUMENTS"] },
    {
      type: "custom",
      name: "home-ops-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["LIFE", "MESSAGE", "CALENDAR", "OWNER_DOCUMENTS"],
        description: "home operations decision review",
        includesAny: ["delivery", "maintenance", "errand", "appointment", "reservation", "support"],
      }),
    },
    judgeRubric({
      name: "executive-home-ops-rubric",
      threshold: 0.7,
      description:
        "Agent turns home operations into a concise set of decisions and actions.",
    }),
  ],
});
