import { scenario } from "@elizaos/scenario-schema";
import {
  expectApprovalRequest,
  expectApprovalStateTransition,
  expectNoSideEffectOnReject,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "travel.book-flight-after-approval",
  title: "Flight booking is gated on explicit approval, never auto-fired",
  domain: "lifeops.travel",
  tags: ["lifeops", "travel", "approval", "duffel"],
  description:
    "Two-turn approval lifecycle. Turn 1 proposes the booking and creates a PENDING approval. Turn 2 transitions PENDING → APPROVED, and only then does the BOOK_TRAVEL action actually run against Duffel.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Flight booking after approval",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-flight",
      room: "main",
      text: "Book me the United 9am SFO → JFK flight next Monday in economy plus, aisle. Confirm with me before charging.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["BOOK_TRAVEL"],
        description: "flight proposal pending approval",
        includesAny: ["United", "SFO", "JFK", "approve", "confirm"],
      }),
      responseIncludesAny: ["United", "SFO", "JFK", "approve", "confirm"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must describe the concrete flight (airline, route, time, cabin) and gate the booking on explicit approval. A reply that books silently fails.",
      },
    },
    {
      kind: "message",
      name: "confirm-flight",
      room: "main",
      text: "Yes, go ahead and book it.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["APPROVE_REQUEST", "BOOK_TRAVEL"],
        description: "approval and booking dispatch",
        includesAny: ["book", "confirm", "reference"],
      }),
      responseIncludesAny: ["book", "confirmation", "reference", "United"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm the booking succeeded after approval and surface confirmation handle / reference. A second 'should I book?' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BOOK_TRAVEL", "APPROVE_REQUEST"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
      actionName: ["BOOK_TRAVEL"],
      state: ["pending", "approved", "executing", "done"],
    },
    {
      type: "approvalStateTransition",
      from: "pending",
      to: "approved",
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "noSideEffectOnReject",
      actionName: ["BOOK_TRAVEL"],
    },
    {
      type: "custom",
      name: "travel-book-after-approval-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["BOOK_TRAVEL", "APPROVE_REQUEST"],
        description: "approval-gated booking",
      }),
    },
    {
      type: "custom",
      name: "travel-book-pending-on-first-turn",
      predicate: expectApprovalRequest({
        description: "first turn created a pending approval, not a booking",
        state: "pending",
        actionName: ["BOOK_TRAVEL"],
      }),
    },
    {
      type: "custom",
      name: "travel-book-state-machine-progress",
      predicate: expectApprovalStateTransition({
        description:
          "approval moved pending → approved before booking dispatch",
        from: "pending",
        to: "approved",
        actionName: ["BOOK_TRAVEL"],
      }),
    },
    {
      type: "custom",
      name: "travel-book-no-side-effect-on-reject",
      predicate: expectNoSideEffectOnReject({
        description:
          "no Duffel booking would fire if the approval were rejected",
        actionName: ["BOOK_TRAVEL"],
      }),
    },
    judgeRubric({
      name: "travel-book-after-approval-rubric",
      threshold: 0.7,
      description:
        "End-to-end: turn 1 created pending approval; turn 2 approved → booking dispatched; rejection path would suppress booking.",
    }),
  ],
});
