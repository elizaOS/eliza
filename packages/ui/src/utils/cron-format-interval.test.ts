/**
 * Tests for cron-format interval validation — ensures every-N-minutes
 * rejects invalid intervals outside 1..59.
 */
import { describe, expect, it } from "vitest";
import { describeCron } from "./cron-format.ts";

describe("cron-format interval validation", () => {
  it("rejects interval 0", () => {
    expect(describeCron("*/0 * * * *")).toBeNull();
  });

  it("rejects interval 60 and above", () => {
    expect(describeCron("*/60 * * * *")).toBeNull();
    expect(describeCron("*/100 * * * *")).toBeNull();
    expect(describeCron("*/999 * * * *")).toBeNull();
  });

  it("accepts valid intervals 1..59", () => {
    expect(describeCron("*/1 * * * *")).toBe("Every 1 minutes");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("*/59 * * * *")).toBe("Every 59 minutes");
  });

  it("still rejects malformed every-N shapes", () => {
    expect(describeCron("*/ * * * *")).toBeNull();
    expect(describeCron("*/a * * * *")).toBeNull();
  });
});
