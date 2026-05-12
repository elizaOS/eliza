import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.book-hotel-with-loyalty-number",
  title: "Hotel booking attaches the user's loyalty number from profile",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "hotel", "loyalty", "profile"],
  description:
    "User has a Marriott Bonvoy number on file. When booking a hotel the agent must surface and include that loyalty number in the BOOK_TRAVEL parameters, not silently book without it.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Hotel booking with loyalty",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "profile",
        loyalty: {
          marriott: "MR12345678",
          hilton: "HH98765432",
        },
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "hotel-with-loyalty",
      room: "main",
      text: "Book me 3 nights at the Marriott Marquis in NYC starting Friday. Use my Bonvoy number.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "PROFILE"],
        description: "hotel booking with loyalty attached",
        includesAny: ["Marriott", "Bonvoy", "MR12345678", "loyalty"],
      }),
      responseIncludesAny: ["Marriott", "Bonvoy", "loyalty", "MR12345678"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must reference attaching the Bonvoy number to the reservation. Booking without surfacing the loyalty number, or asking for it again while it's on file, both fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL", "PROFILE"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["BOOK_TRAVEL"],
      includesAny: ["Marriott", "Bonvoy", "MR12345678", "loyalty"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "custom",
      name: "travel-hotel-loyalty-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "PROFILE"],
        description: "loyalty-attached hotel booking",
        includesAny: ["Bonvoy", "Marriott", "MR12345678", "loyalty"],
      }),
    },
    {
      type: "custom",
      name: "travel-hotel-loyalty-approval",
      predicate: expectApprovalRequest({
        description: "hotel booking is approval-gated, even with loyalty attached",
        actionName: ["BOOK_TRAVEL"],
      }),
    },
    judgeRubric({
      name: "travel-hotel-loyalty-rubric",
      threshold: 0.7,
      description:
        "The agent attached the on-file Bonvoy number to the booking parameters. Forgetting it, or re-asking for it, fails.",
    }),
  ],
});
