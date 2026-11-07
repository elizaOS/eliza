import type { PlannerStep } from "@elizaos/core";
import { expect, it } from "vitest";
import { trajectoryStepsToMessages } from "../planner-rendering";

// Live QA trajectories showed the planner its own operationKey and catalog
// schemas for operationKey/idempotencyKey as "[REDACTED]", an invitation to
// copy the mask back into tool arguments. Request ids stay exact on the model
// wire; credentials stay masked.
it("keeps request ids exact in model-bound tool history and masks credentials", () => {
  const credential = ["fixture", "only", "credential"].join("-");
  const [call, result] = trajectoryStepsToMessages([
    {
      iteration: 1,
      toolCall: {
        id: "tool-1",
        name: "DISCOVER_ACTIONS",
        params: { operationKey: "browser-open-example", apiKey: credential },
      },
      result: {
        success: true,
        text: "Catalog",
        data: {
          dedupeKey: "trigger-dedupe-1",
          catalog: [
            {
              name: "DEVICE_BROWSER_OPEN",
              parameters: {
                type: "object",
                properties: {
                  operationKey: { type: "string", description: "Fresh UUID" },
                  idempotencyKey: { type: "string" },
                  groupKey: { type: "string" },
                },
              },
            },
          ],
          password: credential,
        },
      },
    } as PlannerStep,
  ]);
  const input = (call.content as Array<{ input?: Record<string, unknown> }>)[0]
    .input;
  expect(input).toEqual({
    operationKey: "browser-open-example",
    apiKey: "[REDACTED]",
  });
  const wire = (result.content as Array<{ output: { value: string } }>)[0]
    .output.value;
  expect(wire).not.toContain(credential);
  const data = JSON.parse(wire).data;
  expect(data.dedupeKey).toBe("trigger-dedupe-1");
  expect(data.password).toBe("[REDACTED]");
  expect(data.catalog[0].parameters.properties).toEqual({
    operationKey: { type: "string", description: "Fresh UUID" },
    idempotencyKey: { type: "string" },
    groupKey: { type: "string" },
  });
});
