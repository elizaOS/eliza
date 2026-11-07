import { beforeEach, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../mutations/resolve.js", () => ({
  resolveCalendarApproval: s.resolve,
}));
vi.mock("@elizaos/core", async () => ({
  ...(await import("../../../../packages/core/src/types/effects.js")),
  OWNER_EXCLUSIVE_DISCLOSURE_GATE: {},
}));

import { calendarReviewAction } from "./calendar-review.js";

const acceptedAt = "2026-10-15T21:05:55.892Z";
const succeeded = {
  kind: "succeeded",
  duplicateSuppressed: false,
  attempt: { id: "attempt", operationKey: "stable-key" },
  receipt: {
    operation: "schedule_event",
    providerEventId: "event",
    providerVersion: '"etag"',
    acceptedAt,
    eventSnapshot: { title: "QA event" },
  },
};
async function run() {
  return calendarReviewAction.handler(
    {} as never,
    { id: "owner-message" } as never,
    undefined,
    { parameters: { requestId: "review", decision: "approve" } },
    vi.fn(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  s.resolve.mockResolvedValue(succeeded);
});
it("grounds a terminal confirmation in actual provider acceptance", async () => {
  const result = await run();
  expect(result).toMatchObject({
    success: true,
    turnComplete: true,
    verifiedUserFacing: true,
    userFacingText: "Completed Calendar schedule event: QA event.",
    userFacingEffectReceiptIds: ["calendar-review:review:attempt"],
    effectReceipts: [
      {
        outcome: "applied",
        commit: {
          kind: "provider_accepted",
          id: "event",
          committedAt: acceptedAt,
        },
        artifacts: [{ kind: "calendar.event", id: "event", version: '"etag"' }],
      },
    ],
  });
  expect(calendarReviewAction.suppressPostActionContinuation).toBe(true);
});
it("reuses the ledger receipt on replay instead of claiming a new write", async () => {
  s.resolve.mockResolvedValue({ ...succeeded, duplicateSuppressed: true });
  expect(await run()).toMatchObject({
    success: true,
    turnComplete: true,
    userFacingText: "Already completed Calendar schedule event: QA event.",
    effectReceipts: [
      { outcome: "noop", idempotency: { key: "stable-key", replayed: true } },
    ],
  });
});
it("never represents an unresolved provider outcome as applied", async () => {
  s.resolve.mockResolvedValue({ kind: "reconciliation_required" });
  expect(await run()).toMatchObject({
    success: false,
    turnComplete: true,
    effectReceipts: [
      {
        outcome: "failed",
        failure: { acceptance: "unknown", retryable: false },
      },
    ],
  });
});
it("grounds rejection in the persisted approval record", async () => {
  s.resolve.mockResolvedValue({
    kind: "rejected",
    request: { id: "review", updatedAt: new Date(acceptedAt) },
  });
  expect(await run()).toMatchObject({
    success: true,
    effectReceipts: [
      {
        outcome: "applied",
        commit: { kind: "durable", id: "review" },
        artifacts: [],
      },
    ],
  });
});
