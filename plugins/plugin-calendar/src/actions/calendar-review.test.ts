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

const resolvedAt = "2026-10-15T21:05:55.892Z";
async function run(decision: string) {
  const callback = vi.fn();
  const result = await calendarReviewAction.handler(
    {} as never,
    { id: "owner-message" } as never,
    undefined,
    { parameters: { requestId: "review", decision } },
    callback,
  );
  return { result, callback };
}
beforeEach(() => {
  vi.clearAllMocks();
  s.resolve.mockResolvedValue({
    kind: "rejected",
    request: { id: "review", updatedAt: new Date(resolvedAt) },
  });
});
it("never approves from a model tool call", async () => {
  const { result, callback } = await run("approve");
  expect(s.resolve).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    success: false,
    turnComplete: true,
    userFacingText: "Approve this change in the review dialog.",
  });
  expect(result).not.toHaveProperty("effectReceipts");
  expect(callback).toHaveBeenCalledWith({
    text: "Approve this change in the review dialog.",
  });
});
it("grounds rejection in the persisted approval record", async () => {
  const { result } = await run("reject");
  expect(s.resolve).toHaveBeenCalledWith({}, { id: "owner-message" }, {
    requestId: "review",
    decision: "reject",
  });
  expect(result).toMatchObject({
    success: true,
    turnComplete: true,
    userFacingText: "Calendar change declined. Nothing was changed.",
    userFacingEffectReceiptIds: ["calendar-review:review:owner-message"],
    effectReceipts: [
      {
        outcome: "applied",
        commit: { kind: "durable", id: "review", committedAt: resolvedAt },
        artifacts: [],
      },
    ],
  });
  expect(calendarReviewAction.suppressPostActionContinuation).toBe(true);
});
it("refuses a malformed decision before resolving", async () => {
  const { result } = await run("yes");
  expect(s.resolve).not.toHaveBeenCalled();
  expect(result).toMatchObject({ success: false });
});
