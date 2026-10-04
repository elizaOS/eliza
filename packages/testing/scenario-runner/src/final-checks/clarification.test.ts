import { expect, it } from "vitest";
import { runFinalCheck } from "./index.ts";

it("does not infer a request from prose mentioning clarification", async () => {
  const result = await runFinalCheck(
    { type: "clarificationRequested" },
    {
      runtime: {},
      ctx: {
        actionsCalled: [
          {
            actionName: "REPLY",
            result: { success: true, text: "No clarification is needed." },
          },
        ],
      },
    },
  );
  expect(result.status).toBe("failed");
});
it("recognizes an explicit structured clarification without requiring English wording", async () => {
  const result = await runFinalCheck(
    { type: "clarificationRequested" },
    {
      runtime: {},
      ctx: {
        actionsCalled: [
          {
            actionName: "PERSONALITY",
            result: {
              success: true,
              data: { clarification: "scope" },
              text: "¿Para ti o para todos?",
            },
          },
        ],
      },
    },
  );
  expect(result.status).toBe("passed");
});
