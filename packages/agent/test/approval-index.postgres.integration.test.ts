/**
 * Approval persistence and idempotency tests drive the public agent barrel
 * through plugin-sql's real isolated database harness. The maintained CI lane
 * runs this file against PostgreSQL so partial-index conflict semantics are
 * exercised by the database rather than reimplemented by a test double.
 */

import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugins/plugin-sql/src/__tests__/test-helpers.ts";
import {
  ApprovalIdempotencyConflictError,
  ApprovalService,
  createApprovalQueue,
} from "../src/services/approval/index.ts";

const SUBJECT = "owner-postgres-barrel";

function messageInput(
  overrides: Partial<
    Parameters<ReturnType<typeof createApprovalQueue>["enqueue"]>[0]
  > = {},
) {
  return {
    requestedBy: "agent:postgres-barrel-test",
    subjectUserId: SUBJECT,
    action: "send_message" as const,
    payload: {
      action: "send_message" as const,
      recipient: "+15555551212",
      body: "Hello!",
      replyToMessageId: null,
    },
    channel: "sms" as const,
    reason: "agent wants owner confirmation",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("approval barrel against real SQL", () => {
  let setup: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;

  beforeAll(async () => {
    setup = await createIsolatedTestDatabase("agent_approval_index_postgres");
  }, 120_000);

  afterAll(async () => {
    await setup?.cleanup();
  });

  it("round-trips durable requests through the default and explicit partitions", async () => {
    const service = await ApprovalService.start(setup.runtime);
    const ownQueue = service.getQueue();
    const inserted = await ownQueue.enqueueWithResult(
      messageInput({ idempotencyKey: "postgres-roundtrip-1" }),
    );

    expect(inserted.reused).toBe(false);
    expect(inserted.request).toMatchObject({
      state: "pending",
      idempotencyKey: "postgres-roundtrip-1",
      action: "send_message",
      channel: "sms",
    });
    expect(inserted.request.createdAt).toBeInstanceOf(Date);
    expect(inserted.request.expiresAt).toBeInstanceOf(Date);
    expect(inserted.request.execution).toBeNull();
    await expect(
      ownQueue.byId(inserted.request.id, SUBJECT),
    ).resolves.toMatchObject({ id: inserted.request.id });

    const otherAgentId = randomUUID() as UUID;
    const created = await setup.adapter.createAgent({
      ...setup.runtime.character,
      id: otherAgentId,
      name: "Approval partition test agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(created).toBe(true);

    const explicitQueue = service.getQueue(otherAgentId);
    const explicit = await explicitQueue.enqueue(
      messageInput({
        subjectUserId: `${SUBJECT}-explicit`,
        idempotencyKey: "postgres-explicit-partition-1",
      }),
    );
    await expect(
      ownQueue.byId(explicit.id, `${SUBJECT}-explicit`),
    ).resolves.toBeNull();
    await expect(
      explicitQueue.byId(explicit.id, `${SUBJECT}-explicit`),
    ).resolves.toMatchObject({ id: explicit.id });
  });

  it("atomically reuses one row for concurrent and sequential retries", async () => {
    const queue = createApprovalQueue(setup.runtime, {
      agentId: setup.testAgentId,
    });
    const input = messageInput({
      subjectUserId: `${SUBJECT}-idempotency`,
      idempotencyKey: "postgres-idempotency-1",
    });

    const concurrent = await Promise.all([
      queue.enqueueWithResult(input),
      queue.enqueueWithResult(input),
    ]);
    expect(concurrent.map(({ reused }) => reused).sort()).toEqual([
      false,
      true,
    ]);
    expect(new Set(concurrent.map(({ request }) => request.id)).size).toBe(1);

    const replay = await queue.enqueueWithResult(input);
    expect(replay).toMatchObject({
      reused: true,
      request: { id: concurrent[0].request.id },
    });

    const rows = await queue.list({
      subjectUserId: `${SUBJECT}-idempotency`,
      state: null,
      action: null,
    });
    expect(
      rows.filter((row) => row.idempotencyKey === input.idempotencyKey),
    ).toHaveLength(1);
  });

  it("rejects a reused key that describes a different immutable approval", async () => {
    const queue = createApprovalQueue(setup.runtime, {
      agentId: setup.testAgentId,
    });
    const input = messageInput({
      subjectUserId: `${SUBJECT}-conflict`,
      idempotencyKey: "postgres-conflict-1",
    });
    const original = await queue.enqueue(input);

    await expect(
      queue.enqueue({ ...input, reason: "changed immutable intent" }),
    ).rejects.toMatchObject({
      constructor: ApprovalIdempotencyConflictError,
      idempotencyKey: "postgres-conflict-1",
    });
    await expect(
      queue.byId(original.id, `${SUBJECT}-conflict`),
    ).resolves.toMatchObject({
      id: original.id,
      reason: "agent wants owner confirmation",
    });
  });

  it("stores blank idempotency keys as null without collapsing requests", async () => {
    const queue = createApprovalQueue(setup.runtime, {
      agentId: setup.testAgentId,
    });
    const first = await queue.enqueueWithResult(
      messageInput({
        subjectUserId: `${SUBJECT}-blank-key`,
        idempotencyKey: "   ",
        reason: "first blank-key request",
      }),
    );
    const second = await queue.enqueueWithResult(
      messageInput({
        subjectUserId: `${SUBJECT}-blank-key`,
        idempotencyKey: "   ",
        reason: "second blank-key request",
      }),
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(second.request.id).not.toBe(first.request.id);
    expect(first.request.idempotencyKey).toBeNull();
    expect(second.request.idempotencyKey).toBeNull();
  });
});
