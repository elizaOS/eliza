import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.partial-day-trip-no-hotel",
  title: "Same-day trip books flight only, does not auto-include a hotel",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "same-day", "hotel"],
  description:
    "User asks for a same-day there-and-back trip. The agent must book only flights and NOT silently add a hotel — even if 'overnight stay' or 'standard trip' templates exist. Catches a 'helpful' over-booking failure mode.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Same-day trip no hotel",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "same-day-trip",
      room: "main",
      text: "Book me a same-day round trip SFO ↔ LAX tomorrow. Out early, back by dinner. No hotel needed.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "flight-only same-day booking",
        includesAny: ["SFO", "LAX", "round trip", "same day"],
      }),
      responseIncludesAny: ["SFO", "LAX", "round", "flight"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must propose flights only — no hotel. Adding a hotel anyway, or asking 'would you like a hotel?' against the user's stated 'no hotel needed', both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["BOOK_TRAVEL"],
      includesAny: ["SFO", "LAX", "flight", "round"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "custom",
      name: "travel-same-day-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "flight-only same-day booking",
      }),
    },
    {
      type: "custom",
      name: "travel-same-day-approval",
      predicate: expectApprovalRequest({
        description: "flight booking still requires approval",
        actionName: ["BOOK_TRAVEL"],
      }),
    },
    judgeRubric({
      name: "travel-partial-day-rubric",
      threshold: 0.7,
      description:
        "Agent booked only flights for a same-day trip — no hotel auto-added.",
    }),
  ],
});
