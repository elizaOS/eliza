/**
 * Unit tests for cron interval validation in human-readable descriptions.
 * Validates every-N-minutes boundaries (accepting 1..59, rejecting 0, 60+, non-finite, and malformed intervals)
 * and raw expression fallback preservation.
 */
import { describe, expect, it } from "vitest";
import { describeCron, formatSchedule } from "./cron-format.js";

describe("cron-format interval validation", () => {
  it("rejects interval 0", () => {
    expect(describeCron("*/0 * * * *")).toBeNull();
    expect(formatSchedule("*/0 * * * *")).toBe("*/0 * * * *");
  });

  it("rejects interval 60 and above (standard 5-field cron minute range is 0-59)", () => {
    expect(describeCron("*/60 * * * *")).toBeNull();
    expect(describeCron("*/100 * * * *")).toBeNull();
    expect(describeCron("*/999 * * * *")).toBeNull();
    expect(formatSchedule("*/60 * * * *")).toBe("*/60 * * * *");
  });

  it("accepts valid minute intervals 1..59", () => {
    expect(describeCron("*/1 * * * *")).toBe("Every 1 minutes");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("*/30 * * * *")).toBe("Every 30 minutes");
    expect(describeCron("*/59 * * * *")).toBe("Every 59 minutes");
    expect(formatSchedule("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("rejects malformed every-N shapes", () => {
    expect(describeCron("*/ * * * *")).toBeNull();
    expect(describeCron("*/a * * * *")).toBeNull();
    expect(describeCron("*/-5 * * * *")).toBeNull();
  });
});
