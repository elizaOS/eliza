import { describe, expect, it } from "vitest";
import { planJob, BackgroundPlannerError } from "./background-planner.ts";

const isWellFormed = (value: string) =>
  (value as unknown as { isWellFormed(): boolean }).isWellFormed?.() ?? true;

describe("background-planner surrogate truncation", () => {
  it("surrogate-safe truncates unparsable planner output", async () => {
    const runtime = {
      useModel: async () =>
        `${"a".repeat(199)}🦊${"b".repeat(200)}`,
    } as any;

    await expect(
      planJob(runtime, {
        jobKind: "TEST" as any,
        channel: "test",
        prompt: "x",
      }),
    ).rejects.toThrow((err: BackgroundPlannerError) => {
      const message = err.message;
      expect(isWellFormed(message)).toBe(true);
      expect(message.length).toBeLessThanOrEqual(220);
      return true;
    });
  });
});
