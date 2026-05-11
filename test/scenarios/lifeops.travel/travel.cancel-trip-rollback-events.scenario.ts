import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "travel.cancel-trip-rollback-events",
  title: "Cancelling a trip rolls back the calendar holds it created",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "calendar", "cancel", "rollback"],
  description:
    "When a trip is cancelled the agent must propose removing the calendar events it created for that trip (flight blocks, travel-blackout focus, hotel check-in/out) — not leave them as zombies. Both BOOK_TRAVEL.cancel and CALENDAR delete proposals are approval-gated.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cancel trip rollback",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "trip",
        id: "trip-NYC-2026-q2",
        destination: "JFK",
        flight: { carrier: "United", flightNumber: "UA245", confirmation: "PNR42X" },
        hotel: { name: "Marriott Marquis", confirmation: "MA112233" },
        calendarHolds: [
          { id: "evt-flight-out", title: "United UA245 SFO→JFK" },
          { id: "evt-flight-back", title: "United UA246 JFK→SFO" },
          { id: "evt-hotel-stay", title: "Marriott Marquis (Mar 12–14)" },
          { id: "evt-travel-focus", title: "Travel blackout — NYC trip" },
        ],
        bookedFor: new Date(now + 30 * DAY_MS).toISOString(),
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cancel-trip",
      room: "main",
      text: "Cancel the NYC trip — flight, hotel, and clear the calendar holds. The whole thing is off.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR"],
        description: "trip cancellation with calendar rollback",
        includesAny: ["cancel", "calendar", "hold", "flight", "hotel"],
      }),
      responseIncludesAny: ["cancel", "flight", "hotel", "calendar"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must enumerate the calendar holds that will be removed AND queue the flight/hotel cancellations. All side effects are approval-gated. Leaving zombie events fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL", "CALENDAR"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["BOOK_TRAVEL", "CALENDAR"],
    },
    {
      type: "noSideEffectOnReject",
      actionName: ["BOOK_TRAVEL", "CALENDAR"],
    },
    {
      type: "custom",
      name: "travel-cancel-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR"],
        description: "trip cancellation + calendar rollback",
      }),
    },
    {
      type: "custom",
      name: "travel-cancel-approval-gated",
      predicate: expectApprovalRequest({
        description: "cancellation side effects are approval-gated",
        actionName: ["BOOK_TRAVEL", "CALENDAR"],
      }),
    },
    judgeRubric({
      name: "travel-cancel-rollback-rubric",
      threshold: 0.7,
      description:
        "End-to-end: agent enumerated the calendar holds tied to the trip and queued their removal alongside the booking cancellations. No zombie events.",
    }),
  ],
});
