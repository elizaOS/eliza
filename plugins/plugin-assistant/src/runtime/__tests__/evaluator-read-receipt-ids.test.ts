/**
 * A receipt ID grounds a reply that claims a completed change. A read-only
 * answer that cites one anyway (the model copies a read's own receipt) claims
 * nothing with it: sending that verdict back costs another planner call and
 * another evaluator call for an answer that is already right.
 *
 * That holds only for an ID that proves nothing either way. A pending phone
 * proposal's preview receipt, a failure and a rollback each record a change
 * that is not in place, and a reply citing one goes back whatever status the
 * verdict reports: the device tool gives a pending proposal a preview receipt
 * so that this ID match refuses it as proof.
 */
import type {
  ContextObject,
  EffectReceipt,
  PlannerToolResult,
  PlannerTrajectory,
} from "@elizaos/core";
import { expect, it } from "vitest";
import type { ApprovalEnqueueResult } from "../../services/approval/types.ts";
import {
  DEVICE_APPROVAL_REVIEW_TEXT,
  deviceActionEffectReceipts,
  deviceApprovalPersistenceReceipt,
} from "../../services/device-actions/effect-receipts.ts";
import { runEvaluator } from "../evaluator.ts";

const READ_RECEIPT = "calendar-feed-read-receipt-v1:ae96120f";
const COMMITTED_RECEIPT = "notes-mutation-receipt-v1:create";
const OBSERVED_AT = "2026-11-20T21:25:00.000Z";

const receipt = {
  receiptId: "",
  operation: "notes.note.create",
  resource: { kind: "notes.note", id: "note-1" },
  artifacts: [],
  idempotency: { key: "create-key", replayed: false },
  observedAt: OBSERVED_AT,
};
const COMMITTED: EffectReceipt = {
  ...receipt,
  receiptId: COMMITTED_RECEIPT,
  outcome: "applied",
  commit: { kind: "durable", id: "note-1", committedAt: OBSERVED_AT },
};
/** The record a calendar read leaves: it changed nothing and proves no change. */
const readRecord = (operation: string): EffectReceipt => ({
  ...receipt,
  receiptId: `${operation}:snapshot`,
  operation,
  resource: { kind: "calendar.feed", id: "feed", version: OBSERVED_AT },
  idempotency: { key: null, replayed: false },
  outcome: "noop",
  reason:
    "The operation read an authoritative calendar snapshot without changing it.",
});

const context: ContextObject = {
  id: "turn",
  events: [
    {
      id: "current",
      type: "message",
      message: {
        id: "current",
        role: "user",
        content: "What's on my calendar tomorrow?",
      },
    },
  ],
};

/** The queue row a phone proposal leaves, pending until the owner decides. */
function queuedProposal(id: string): ApprovalEnqueueResult {
  const at = new Date(OBSERVED_AT);
  return {
    reused: false,
    request: {
      id,
      createdAt: at,
      updatedAt: at,
      state: "pending",
      requestedBy: "agent",
      subjectUserId: "owner",
      action: "device_action",
      payload: {
        action: "device_action",
        version: 1,
        installationId: "phone",
        enrollmentId: "enrollment",
        operation: {
          type: "create_note",
          title: "Fixture note",
          body: "Synthetic test data only",
        },
      } as ApprovalEnqueueResult["request"]["payload"],
      channel: "sms",
      reason: "Requested by test owner",
      idempotencyKey: `device:${id}`,
      expiresAt: new Date(Date.now() + 600_000),
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      execution: null,
    },
  };
}

/** What the device tool returns for a proposal the owner has not approved,
 * with the receipts the tool itself attaches. */
function pendingProposal(id: string): PlannerToolResult {
  const outcome = queuedProposal(id);
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    effectReceipts: deviceActionEffectReceipts(outcome),
    userFacingText: DEVICE_APPROVAL_REVIEW_TEXT,
    text: "Durable device proposal state: pending. This tool has performed no device operation.",
    data: {
      proposalId: id,
      state: "pending",
      executed: false,
      approvalPersistence: deviceApprovalPersistenceReceipt(outcome),
      awaitingUserInput: true,
      approvalRequired: true,
    },
  };
}

type Step = PlannerTrajectory["steps"][number];

const readStep = (effectReceipts: EffectReceipt[] = []): Step => ({
  iteration: 1,
  toolCall: { id: "feed", name: "CALENDAR_FEED", params: {} },
  result: {
    success: true,
    data: { events: [], readReceiptId: READ_RECEIPT },
    ...(effectReceipts.length ? { effectReceipts } : {}),
  },
});

const proposalStep = (id: string): Step => ({
  iteration: 1,
  toolCall: { id: "propose", name: "PROPOSE_DEVICE_ACTION", params: {} },
  result: pendingProposal(id),
});

/** The same proposal one step later in its life: the tool's receipt is a no-op,
 * because approval or rejection alone is never execution. */
const settledProposalStep = (
  id: string,
  state: "approved" | "rejected",
): Step => {
  const queued = queuedProposal(id);
  return {
    iteration: 1,
    toolCall: { id: "propose", name: "PROPOSE_DEVICE_ACTION", params: {} },
    result: {
      ...pendingProposal(id),
      effectReceipts: deviceActionEffectReceipts({
        ...queued,
        request: { ...queued.request, state },
      } as typeof queued),
    },
  };
};

function evaluate(
  verdict: Record<string, unknown>,
  options: {
    committed?: boolean;
    steps?: Step[];
    redactSecrets?: (text: string) => string;
  },
) {
  let calls = 0;
  const trajectory = {
    context,
    modelBaseContext: context,
    outcomeIntents: ["read tomorrow's calendar"],
    steps: options.steps ?? [readStep(options.committed ? [COMMITTED] : [])],
    archivedSteps: [],
    plannedQueue: [],
    evaluatorOutputs: [],
  } as PlannerTrajectory;
  return runEvaluator({
    context,
    trajectory,
    runtime: {
      ...(options.redactSecrets
        ? { redactSecrets: options.redactSecrets }
        : {}),
      useModel: async () => {
        calls += 1;
        if (calls > 1) throw new Error("the evaluator ran more than once");
        return JSON.stringify({
          thought: "The feed for tomorrow returned no events.",
          success: true,
          decision: "FINISH",
          requestFullyCovered: true,
          messageToUser: "Nothing on your calendar tomorrow.",
          ...verdict,
        });
      },
    },
  } as never);
}

it.each(["none", "non_applied"] as const)(
  "finishes a %s reply that cites a receipt the turn never committed, without that id",
  async (replyEffectStatus) => {
    const output = await evaluate(
      { replyEffectStatus, effectReceiptIds: [READ_RECEIPT] },
      {},
    );
    expect(output.decision).toBe("FINISH");
    expect(output.success).toBe(true);
    expect(output.messageToUser).toBe("Nothing on your calendar tomorrow.");
    expect(output.effectReceiptIds).toEqual([]);
  },
);

it("keeps the committed ids of a reply that claims no change and drops only the others", async () => {
  const output = await evaluate(
    {
      replyEffectStatus: "none",
      effectReceiptIds: [COMMITTED_RECEIPT, READ_RECEIPT],
    },
    { committed: true },
  );
  expect(output.decision).toBe("FINISH");
  expect(output.effectReceiptIds).toEqual([COMMITTED_RECEIPT]);
});

it("still sends back a reply that claims a completed change on a receipt the turn never committed", async () => {
  const output = await evaluate(
    {
      replyEffectStatus: "applied",
      messageToUser: "Added it to your calendar.",
      effectReceiptIds: [READ_RECEIPT],
    },
    {},
  );
  expect(output.decision).toBe("CONTINUE");
  expect(output.success).toBe(false);
  expect(output.messageToUser).toBeUndefined();
  expect(output.effectReceiptIds).toBeUndefined();
});

it("still sends back an applied reply whose receipt was not among the advertised ones", async () => {
  // The receipt is committed, so the completed-change check accepts it, but
  // its id is withheld from the model: only the decision-state guard is left
  // to notice that the model selected an id it was never shown.
  const output = await evaluate(
    {
      replyEffectStatus: "applied",
      messageToUser: "Saved the note.",
      effectReceiptIds: [COMMITTED_RECEIPT],
    },
    {
      committed: true,
      redactSecrets: (text) => text.replaceAll(COMMITTED_RECEIPT, "[hidden]"),
    },
  );
  expect(output.decision).toBe("CONTINUE");
  expect(output.thought).toContain(
    "The selected receipt is not a current committed effect receipt.",
  );
  expect(output.messageToUser).toBeUndefined();
});

it.each(["calendar.feed.read", "calendar.check_availability.read"])(
  "finishes a read answer that cites the %s record of its own read",
  async (operation) => {
    const read = readRecord(operation);
    for (const replyEffectStatus of ["none", "non_applied", undefined]) {
      const output = await evaluate(
        { replyEffectStatus, effectReceiptIds: [read.receiptId] },
        { steps: [readStep([read])] },
      );
      expect(output.decision).toBe("FINISH");
      expect(output.success).toBe(true);
      expect(output.messageToUser).toBe("Nothing on your calendar tomorrow.");
      expect(output.effectReceiptIds).toEqual([]);
    }
  },
);

it.each(["non_applied", "none", undefined])(
  "sends back a reply that states a pending phone proposal as done and cites its preview receipt, status %s",
  async (replyEffectStatus) => {
    const step = proposalStep("proposal-1");
    const preview = step.result?.effectReceipts?.[0];
    expect(preview).toMatchObject({
      operation: "device.create_note",
      outcome: "preview",
    });
    const output = await evaluate(
      {
        thought: "Evaluate the recorded device operation.",
        replyEffectStatus,
        messageToUser: "Your note was created.",
        effectReceiptIds: [preview?.receiptId],
      },
      { steps: [step] },
    );
    expect(output.decision).toBe("CONTINUE");
    expect(output.success).toBe(false);
    expect(output.messageToUser).toBeUndefined();
    expect(output.effectReceiptIds).toBeUndefined();
    expect(output.thought).toContain(
      "The selected receipt is not a current committed effect receipt.",
    );
  },
);

it.each(["approved", "rejected"] as const)(
  "sends back a reply that states an %s phone proposal as done and cites its no-op receipt",
  async (state) => {
    const step = settledProposalStep("proposal-4", state);
    const settled = step.result?.effectReceipts?.[0];
    expect(settled).toMatchObject({
      operation: "device.create_note",
      outcome: "noop",
    });
    for (const replyEffectStatus of ["non_applied", "none", undefined]) {
      const output = await evaluate(
        {
          thought: "Evaluate the recorded device operation.",
          replyEffectStatus,
          messageToUser: "Your note was created.",
          effectReceiptIds: [settled?.receiptId],
        },
        { steps: [step] },
      );
      expect(output.decision).toBe("CONTINUE");
      expect(output.success).toBe(false);
      expect(output.messageToUser).toBeUndefined();
      expect(output.effectReceiptIds).toBeUndefined();
    }
  },
);

it.each(["non_applied", "none", undefined])(
  "does not let a committed receipt carry a pending proposal cited beside it, status %s",
  async (replyEffectStatus) => {
    const step = proposalStep("proposal-2");
    const output = await evaluate(
      {
        replyEffectStatus,
        messageToUser: "I saved the note and set your alarm for 7am.",
        effectReceiptIds: [
          COMMITTED_RECEIPT,
          step.result?.effectReceipts?.[0]?.receiptId,
        ],
      },
      { steps: [readStep([COMMITTED]), { ...step, iteration: 2 }] },
    );
    expect(output.decision).toBe("CONTINUE");
    expect(output.messageToUser).toBeUndefined();
    expect(output.effectReceiptIds).toBeUndefined();
  },
);

const FAILED: EffectReceipt = {
  ...receipt,
  receiptId: "notes-mutation-receipt-v1:failed",
  outcome: "failed",
  failure: {
    code: "NOTE_WRITE_FAILED",
    retryable: false,
    acceptance: "unknown",
  },
};
const ROLLBACK: EffectReceipt = {
  ...receipt,
  receiptId: "notes-mutation-receipt-v1:rollback",
  operation: "notes.note.delete",
  outcome: "rolled_back",
  rollback: {
    receiptId: "notes-rollback-1",
    revertedReceiptIds: [COMMITTED_RECEIPT],
    rolledBackAt: OBSERVED_AT,
  },
};

it.each([
  ["a failed", FAILED.receiptId, [FAILED]],
  ["a rolled-back", ROLLBACK.receiptId, [COMMITTED, ROLLBACK]],
  // The commit itself, which the rollback took back.
  ["a reverted", COMMITTED_RECEIPT, [COMMITTED, ROLLBACK]],
])(
  "sends back a reply that cites %s receipt, whatever status it reports",
  async (_name, cited, effectReceipts) => {
    for (const replyEffectStatus of ["none", "non_applied", undefined]) {
      const output = await evaluate(
        {
          replyEffectStatus,
          messageToUser: "Your note is saved.",
          effectReceiptIds: [cited],
        },
        { steps: [readStep(effectReceipts)] },
      );
      expect(output.decision).toBe("CONTINUE");
      expect(output.success).toBe(false);
      expect(output.messageToUser).toBeUndefined();
      expect(output.effectReceiptIds).toBeUndefined();
    }
  },
);

it("finishes the honest reply to a pending phone proposal, which cites nothing", async () => {
  const output = await evaluate(
    {
      replyEffectStatus: "non_applied",
      messageToUser: "Review and approve the pending request on your phone.",
    },
    { steps: [proposalStep("proposal-3")] },
  );
  expect(output.decision).toBe("FINISH");
  expect(output.messageToUser).toBe(
    "Review and approve the pending request on your phone.",
  );
});
