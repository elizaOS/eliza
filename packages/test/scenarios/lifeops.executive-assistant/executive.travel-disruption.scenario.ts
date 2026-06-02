import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.travel-disruption",
  title:
    "Travel disruption reprioritizes itinerary, calendar, contacts, and expenses",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "travel", "resilience"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Travel disruption",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "travel-disruption",
      room: "main",
      text: "My flight was delayed. Rework travel readiness: calendar conflicts, hotel and ground transport, notify people, preserve receipts, and list approval decisions.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "BOOK_TRAVEL",
          "CALENDAR",
          "MESSAGE",
          "PAYMENTS",
          "RESOLVE_REQUEST",
        ],
        description: "travel disruption recovery",
        includesAny: ["flight", "delayed", "calendar", "notify", "receipts"],
      }),
      responseIncludesAny: [
        /flight|delayed|travel/i,
        /calendar|notify|receipt|approval/i,
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should recover from travel disruption by updating itinerary, calendar, people notifications, receipts, and approval decisions.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "BOOK_TRAVEL",
        "CALENDAR",
        "MESSAGE",
        "PAYMENTS",
        "RESOLVE_REQUEST",
      ],
    },
    {
      type: "custom",
      name: "travel-disruption-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "BOOK_TRAVEL",
          "CALENDAR",
          "MESSAGE",
          "PAYMENTS",
          "RESOLVE_REQUEST",
        ],
        description: "travel disruption recovery",
        includesAny: ["flight", "delayed", "calendar", "notify", "receipts"],
      }),
    },
    judgeRubric({
      name: "executive-travel-disruption-rubric",
      threshold: 0.7,
      description:
        "Agent recovers from a travel disruption with calendar, notification, expense, and approval handling.",
    }),
  ],
});
