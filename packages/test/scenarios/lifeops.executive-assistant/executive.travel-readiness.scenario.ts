import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.travel-readiness",
  title: "Travel readiness checks bookings, buffers, docs, and expenses",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "travel", "readiness"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Travel readiness" },
  ],
  turns: [
    {
      kind: "message",
      name: "travel-readiness",
      room: "main",
      text: "Run travel readiness for next week's NYC trip: flights, hotel, calendar buffers, ground transport, ID/docs, receipts, and expense capture.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR", "OWNER_DOCUMENTS", "PAYMENTS", "LIFE"],
        description: "travel readiness review",
        includesAny: ["NYC", "flight", "hotel", "buffer", "receipt", "expense"],
      }),
      responseIncludesAny: ["NYC", /flight|hotel|buffer|receipt|expense/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must be a travel readiness checklist covering booking, calendar, documents, transport, receipts, and expenses with clear gaps.",
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: ["BOOK_TRAVEL", "CALENDAR", "OWNER_DOCUMENTS", "PAYMENTS", "LIFE"] },
    {
      type: "custom",
      name: "travel-readiness-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR", "OWNER_DOCUMENTS", "PAYMENTS", "LIFE"],
        description: "travel readiness review",
        includesAny: ["NYC", "flight", "hotel", "buffer", "receipt", "expense"],
      }),
    },
    judgeRubric({
      name: "executive-travel-readiness-rubric",
      threshold: 0.7,
      description:
        "Agent checks the full travel readiness chain and surfaces missing decisions instead of just summarizing itinerary.",
    }),
  ],
});
