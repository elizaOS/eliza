/**
 * Tests for delegated communication contract evaluation.
 *
 * The evaluator is intentionally deterministic: seeded inbound turns exercise
 * the policy shape that later runtime wiring will persist and feed from real
 * connector events.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsDelegationContractRecord,
  type DelegationContract,
  evaluateDelegationContract,
  renderDelegationContractsProviderText,
} from "../src/lifeops/delegation-contracts/index.js";
import { LifeOpsRepository } from "../src/lifeops/index.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

function vendorContract(
  overrides: Partial<DelegationContract> = {},
): DelegationContract {
  return {
    contractId: "delegation:vendor-thread",
    objective: "Handle the vendor renewal thread",
    scope: {
      kind: "thread",
      channel: "email",
      threadId: "thread-vendor-1",
    },
    autonomyLevel: "approval_gated",
    tripwires: [{ kind: "price_pushback", label: "vendor pushed on price" }],
    createdAt: "2026-07-06T16:00:00.000Z",
    expiresAt: "2026-07-13T16:00:00.000Z",
    ownerUserId: "owner-1",
    requestedBy: "delegation-contracts",
    ...overrides,
  };
}

describe("delegation contract evaluator", () => {
  it("handles in-bounds delegated turns silently until a price tripwire fires", () => {
    const inBounds = evaluateDelegationContract({
      contract: vendorContract(),
      nowIso: "2026-07-06T16:30:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-vendor-1",
        sender: "Riley Vendor",
        senderEmail: "riley@vendor.example",
        subject: "Renewal",
        text: "We can keep the renewal on the same timeline and send the order form today.",
        receivedAt: "2026-07-06T16:20:00.000Z",
      },
    });

    expect(inBounds.outcome).toBe("in_bounds");
    expect(inBounds.audit).toMatchObject({
      silentTowardOwner: true,
      matchedTripwire: null,
    });
    expect(inBounds.contract.state?.handledTurnCount).toBe(1);

    const tripped = evaluateDelegationContract({
      contract: inBounds.contract,
      nowIso: "2026-07-06T16:45:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-vendor-1",
        sender: "Riley Vendor",
        senderEmail: "riley@vendor.example",
        subject: "Renewal",
        text: "The price is too high; we cannot accept the quote without a discount.",
        receivedAt: "2026-07-06T16:42:00.000Z",
      },
    });

    expect(tripped.outcome).toBe("escalate_owner");
    expect(tripped.escalation).toMatchObject({
      kind: "owner_escalation",
      contractId: "delegation:vendor-thread",
      summary:
        'Riley Vendor tripped "vendor pushed on price" on Handle the vendor renewal thread.',
      sourceText:
        "The price is too high; we cannot accept the quote without a discount.",
    });
    expect(tripped.audit).toMatchObject({
      silentTowardOwner: false,
      matchedTripwire: "vendor pushed on price",
    });

    const duplicate = evaluateDelegationContract({
      contract: tripped.contract,
      nowIso: "2026-07-06T16:50:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-vendor-1",
        sender: "Riley Vendor",
        senderEmail: "riley@vendor.example",
        subject: "Renewal",
        text: "The cost is still too high and procurement needs better terms.",
        receivedAt: "2026-07-06T16:49:00.000Z",
      },
    });

    expect(duplicate.outcome).toBe("already_escalated");
    expect(duplicate.escalation).toBeNull();
    expect(duplicate.audit.silentTowardOwner).toBe(true);
  });

  it("queues a board-member holding reply after the SLA when the owner stays silent", () => {
    const contract = vendorContract({
      contractId: "delegation:board-sla",
      objective: "Board member holding reply",
      scope: {
        kind: "sender_class",
        channel: "email",
        senderClass: "board_member",
      },
      tripwires: [],
      sla: {
        holdingReplyAfterMinutes: 60,
        subjectPrefix: "Re:",
        holdingReplyBody:
          "Thanks, I have this and will come back with a proper answer shortly.",
      },
    });

    const due = evaluateDelegationContract({
      contract,
      nowIso: "2026-07-06T18:05:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-board-1",
        sender: "Dana Board",
        senderClass: "board_member",
        senderEmail: "dana@board.example",
        subject: "Quarterly update",
        text: "Can you send the latest numbers?",
        receivedAt: "2026-07-06T17:00:00.000Z",
      },
    });

    expect(due.outcome).toBe("holding_reply_due");
    expect(due.audit.silentTowardOwner).toBe(true);
    expect(due.draftIntent).toMatchObject({
      action: "send_email",
      channel: "email",
      requestedBy: "delegation-contracts",
      subjectUserId: "owner-1",
      payload: {
        action: "send_email",
        to: ["dana@board.example"],
        subject: "Re: Quarterly update",
        body: "Thanks, I have this and will come back with a proper answer shortly.",
        threadId: "thread-board-1",
      },
    });
    expect(due.contract.state?.holdingReplyQueuedAt).toBe(
      "2026-07-06T18:05:00.000Z",
    );
  });

  it("suppresses the SLA holding reply when the owner replies inside the hour", () => {
    const contract = vendorContract({
      contractId: "delegation:board-sla",
      objective: "Board member holding reply",
      scope: {
        kind: "sender_class",
        channel: "email",
        senderClass: "board_member",
      },
      tripwires: [],
      sla: {
        holdingReplyAfterMinutes: 60,
        holdingReplyBody: "Thanks, I have this.",
      },
    });

    const suppressed = evaluateDelegationContract({
      contract,
      nowIso: "2026-07-06T18:05:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-board-1",
        sender: "Dana Board",
        senderClass: "board_member",
        senderEmail: "dana@board.example",
        subject: "Quarterly update",
        text: "Can you send the latest numbers?",
        receivedAt: "2026-07-06T17:00:00.000Z",
        ownerRepliedAt: "2026-07-06T17:30:00.000Z",
      },
    });

    expect(suppressed.outcome).toBe("holding_reply_suppressed");
    expect(suppressed.draftIntent).toBeNull();
    expect(suppressed.audit.reason).toBe(
      "owner replied before the holding-reply SLA elapsed",
    );
  });
});

describe("delegation contract repository", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("persists active thread contracts and their evaluator state", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repo = new LifeOpsRepository(runtime);
    const record = createLifeOpsDelegationContractRecord({
      ...vendorContract(),
      agentId: runtime.agentId,
      metadata: { sourceThread: "gmail:thread-vendor-1" },
    });

    await repo.upsertDelegationContract(record);

    const rows = await repo.listDelegationContracts(runtime.agentId, {
      statuses: ["active"],
      activeAtIso: "2026-07-06T16:30:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contractId: "delegation:vendor-thread",
      status: "active",
      autonomyLevel: "approval_gated",
      metadata: { sourceThread: "gmail:thread-vendor-1" },
    });
    expect(renderDelegationContractsProviderText(rows)).toContain(
      "Handle the vendor renewal thread",
    );

    const evaluated = evaluateDelegationContract({
      contract: rows[0],
      nowIso: "2026-07-06T16:45:00.000Z",
      turn: {
        channel: "email",
        threadId: "thread-vendor-1",
        sender: "Riley Vendor",
        senderEmail: "riley@vendor.example",
        subject: "Renewal",
        text: "The price is too high; we need a discount.",
        receivedAt: "2026-07-06T16:42:00.000Z",
      },
    });

    await repo.upsertDelegationContract({
      ...rows[0],
      state: evaluated.contract.state,
      updatedAt: "2026-07-06T16:45:00.000Z",
    });

    const reloaded = await repo.getDelegationContract(
      runtime.agentId,
      "delegation:vendor-thread",
    );
    expect(reloaded?.state?.escalatedAt).toBe("2026-07-06T16:42:00.000Z");
  });
});
