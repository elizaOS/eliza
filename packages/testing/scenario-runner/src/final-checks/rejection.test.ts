import { expect, it } from "vitest";
import { runFinalCheck } from "./index.ts";

const check = { type: "noSideEffectOnReject", actionName: "SEND" } as const;
const cancelled = {
  actionsCalled: [
    {
      actionName: "SEND",
      result: { success: true, data: { cancelled: true } },
    },
  ],
};
it("does not mistake model confirmation parameters for an actual rejection", async () => {
  const result = await runFinalCheck(check, {
    runtime: {},
    ctx: {
      actionsCalled: [
        {
          actionName: "SEND",
          parameters: { confirmed: false },
          result: { success: true },
        },
      ],
    },
    observeRejectedEffects: async () => [],
  });
  expect(result.status).toBe("failed");
});
it("requires independent effects evidence even after an explicit cancellation", async () => {
  expect(
    (await runFinalCheck(check, { runtime: {}, ctx: cancelled })).status,
  ).toBe("failed");
  expect(
    (
      await runFinalCheck(check, {
        runtime: {},
        ctx: cancelled,
        observeRejectedEffects: async () => ["POST /messages"],
      })
    ).status,
  ).toBe("failed");
  expect(
    (
      await runFinalCheck(check, {
        runtime: {},
        ctx: cancelled,
        observeRejectedEffects: async () => [],
      })
    ).status,
  ).toBe("passed");
});
