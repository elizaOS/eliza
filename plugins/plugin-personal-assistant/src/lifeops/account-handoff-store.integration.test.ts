/**
 * Exercises handoff review and checkpoint persistence against real PGlite and
 * production migrations. No connector or account mutation is performed here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import {
  type AccountHandoffReview,
  AccountHandoffStore,
} from "./account-handoff-store.js";

const review: AccountHandoffReview = {
  previous: {
    grantId: "old-grant",
    connectorAccountId: "old-account",
    email: "test@example.test",
  },
  replacement: {
    grantId: "real-grant",
    connectorAccountId: "real-account",
    email: "real@example.test",
  },
  readCalendars: [
    {
      grantId: "real-grant",
      connectorAccountId: "real-account",
      calendarId: "family",
    },
  ],
  writeCalendar: {
    grantId: "real-grant",
    connectorAccountId: "real-account",
    calendarId: "family",
  },
  messageDestinations: [
    {
      channel: "email",
      connectorAccountId: "real-account",
      recipientId: "owner@example.test",
    },
  ],
  importedData: "retain",
  retireApprovalIds: ["old-draft"],
};

describe("account handoff persistence", () => {
  let result: RealTestRuntimeResult;
  beforeAll(async () => {
    result = await createLifeOpsTestRuntime();
  }, 60_000);
  afterAll(async () => {
    await result.cleanup();
  });

  it("admits only one racing review per owner, retaining the exact winner across instances", async () => {
    const store = new AccountHandoffStore(result.runtime, "race-owner");
    const outcomes = await Promise.allSettled([
      store.review("review-one", review),
      store.review("review-two", review),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = await store.active();
    if (!winner) throw new Error("Expected a persisted winner");
    const reopened = new AccountHandoffStore(result.runtime, "race-owner");
    expect(await reopened.read(winner.operationId)).toEqual(winner);
    expect(await reopened.review(winner.operationId, review)).toEqual(winner);
    await expect(
      reopened.review(winner.operationId, {
        ...review,
        importedData: "remove_previous_account_imports",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    const otherOwner = new AccountHandoffStore(result.runtime, "other-owner");
    expect(await otherOwner.read(winner.operationId)).toBeNull();
    expect(await otherOwner.active()).toBeNull();
    await otherOwner.review(winner.operationId, review);
  });

  it("rejects stale and out-of-order checkpoints and retains receipts while advancing", async () => {
    const store = new AccountHandoffStore(result.runtime, "checkpoint-owner");
    await store.review("checkpoint", review);
    const first = {
      operationId: "checkpoint",
      expectedRevision: 0,
      expectedPhase: "reviewed" as const,
      phase: "pausing" as const,
      receipt: { approvalPauseRevision: 4 },
    };
    const outcomes = await Promise.allSettled([
      store.advance(first),
      store.advance(first),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(
      store.advance({
        ...first,
        expectedRevision: 1,
        expectedPhase: "pausing",
        phase: "completed",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_STEP_INVALID" });
    const reopened = new AccountHandoffStore(
      result.runtime,
      "checkpoint-owner",
    );
    const beforeOverwrite = await reopened.read("checkpoint");
    await expect(
      reopened.advance({
        operationId: "checkpoint",
        expectedRevision: 1,
        expectedPhase: "pausing",
        phase: "draining",
        receipt: { approvalPauseRevision: 99 },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(await reopened.read("checkpoint")).toEqual(beforeOverwrite);
    const next = await reopened.advance({
      operationId: "checkpoint",
      expectedRevision: 1,
      expectedPhase: "pausing",
      phase: "draining",
      receipt: { calendarPauseRevision: 9 },
    });
    expect(next.receipt).toEqual({
      approvalPauseRevision: 4,
      calendarPauseRevision: 9,
    });
    expect(next.review).toEqual(review);
    await expect(
      new AccountHandoffStore(result.runtime, "wrong-owner").advance({
        ...first,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    await expect(
      reopened.advance({
        operationId: "checkpoint",
        expectedRevision: 2,
        expectedPhase: "draining",
        phase: "cancelled",
        receipt: {},
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_STEP_INVALID" });
  });

  it("allows cancelling an untouched review and starting a different operation without losing history", async () => {
    const store = new AccountHandoffStore(result.runtime, "cancel-owner");
    await store.review("before", review);
    await store.advance({
      operationId: "before",
      expectedRevision: 0,
      expectedPhase: "reviewed",
      phase: "cancelled",
      receipt: {},
    });
    expect(await store.active()).toBeNull();
    await store.review("after", review);
    expect((await store.read("before"))?.phase).toBe("cancelled");
    expect((await store.active())?.operationId).toBe("after");
  });

  it("rejects mismatched calendar ownership and duplicate accounts before persisting a review", async () => {
    const store = new AccountHandoffStore(result.runtime, "invalid-owner");
    await expect(store.review(" padded-operation ", review)).rejects.toThrow();
    await expect(
      store.review("bad-calendar", {
        ...review,
        writeCalendar: { ...review.readCalendars[0], grantId: "old-grant" },
      }),
    ).rejects.toThrow();
    await expect(
      store.review("same-account", { ...review, replacement: review.previous }),
    ).rejects.toThrow();
    expect(await store.active()).toBeNull();
  });
});
