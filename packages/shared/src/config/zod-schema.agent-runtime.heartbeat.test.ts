/**
 * Exercises heartbeat duration validation through the deterministic shared
 * config schema, including conversion overflow at the user-input boundary.
 */
import { describe, expect, it } from "vitest";
import { HeartbeatSchema } from "./zod-schema.agent-runtime";

describe("HeartbeatSchema duration validation", () => {
  it("accepts a finite heartbeat interval", () => {
    expect(HeartbeatSchema.safeParse({ every: "30m" }).success).toBe(true);
  });

  it("rejects an interval whose default-minute conversion overflows", () => {
    const result = HeartbeatSchema.safeParse({
      every: `1${"0".repeat(306)}`,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["every"],
        }),
      );
    }
  });
});
