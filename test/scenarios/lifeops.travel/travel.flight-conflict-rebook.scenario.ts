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
  id: "travel.flight-conflict-rebook",
  title: "Detect a flight conflict with an existing booking and propose a rebook",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "conflict", "rebook"],
  description:
    "User has an existing United flight on file. They ask to book a Delta flight at an overlapping time. The agent must flag the conflict (not double-book) and offer a concrete rebook plan gated on approval.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Flight conflict rebook",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "booking",
        carrier: "United",
        flightNumber: "UA245",
        origin: "SFO",
        destination: "JFK",
        departAt: new Date(now + 3 * DAY_MS).toISOString(),
        arriveAt: new Date(now + 3 * DAY_MS + 5 * 60 * 60_000).toISOString(),
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-overlap",
      room: "main",
      text: "Book me on Delta DL100 SFO → JFK that leaves the same time as my United next-week flight. I think I want to switch.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR"],
        description: "conflict detection and rebook plan",
        includesAny: ["conflict", "United", "Delta", "rebook", "overlap"],
      }),
      responseIncludesAny: ["conflict", "United", "Delta", "switch"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must surface the conflict with the existing United booking, ask whether to cancel United and book Delta, and gate either side-effect on approval. Silently double-booking, or silently cancelling without naming the existing booking, both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL", "CALENDAR"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["BOOK_TRAVEL"],
      includesAny: ["Delta", "United", "rebook", "conflict"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "noSideEffectOnReject",
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "custom",
      name: "travel-flight-conflict-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "CALENDAR"],
        description: "conflict-aware rebook",
      }),
    },
    {
      type: "custom",
      name: "travel-flight-conflict-approval",
      predicate: expectApprovalRequest({
        description: "rebook is approval-gated",
        actionName: ["BOOK_TRAVEL"],
      }),
    },
    judgeRubric({
      name: "travel-flight-conflict-rubric",
      threshold: 0.7,
      description:
        "Agent named the conflicting United booking, proposed cancel-and-rebook on Delta, and waited for approval.",
    }),
  ],
});
