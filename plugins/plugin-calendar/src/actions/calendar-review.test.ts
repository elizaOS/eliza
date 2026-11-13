import { beforeEach, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../mutations/resolve.js", () => ({
  resolveCalendarApproval: s.resolve,
}));
vi.mock("@elizaos/core", async () => ({
  ...(await import("../../../../packages/core/src/types/effects.js")),
  OWNER_EXCLUSIVE_DISCLOSURE_GATE: {},
}));

import {
  CALENDAR_REVIEW_APPROVE_REFUSAL,
  calendarReviewAction,
} from "./calendar-review.js";

const updatedAt = "2026-10-15T21:05:55.892Z";
async function run(decision: string) {
  return calendarReviewAction.handler(
    {} as never,
    { id: "owner-message" } as never,
    undefined,
    { parameters: { requestId: "review", decision } },
    vi.fn(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  s.resolve.mockResolvedValue({
    kind: "rejected",
    request: { id: "review", updatedAt: new Date(updatedAt) },
  });
});
it("refuses to approve from a model tool call", async () => {
  expect(await run("approve")).toMatchObject({
    success: false,
    turnComplete: true,
    userFacingText: CALENDAR_REVIEW_APPROVE_REFUSAL,
  });
  expect(s.resolve).not.toHaveBeenCalled();
  expect(calendarReviewAction.suppressPostActionContinuation).toBe(true);
});
it("grounds rejection in the persisted approval record", async () => {
  expect(await run("reject")).toMatchObject({
    success: true,
    turnComplete: true,
    userFacingText: "Calendar change declined. Nothing was changed.",
    userFacingEffectReceiptIds: ["calendar-review:review:owner-message"],
    effectReceipts: [
      {
        outcome: "applied",
        commit: { kind: "durable", id: "review", committedAt: updatedAt },
        artifacts: [],
      },
    ],
  });
  expect(s.resolve).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
    requestId: "review",
    decision: "reject",
  });
});
