/**
 * Boundary coverage for the trajectory display formatters (#18527): values
 * whose rounded display reaches a unit boundary must promote to the next unit
 * ("1.0m", never "60.0s"; "1.0M", never "1000.0k"), while every value below
 * the rounding boundary keeps its original unit. Deterministic, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  formatTrajectoryDuration,
  formatTrajectoryTokenCount,
} from "./trajectory-format";

describe("formatTrajectoryDuration", () => {
  it("keeps sub-boundary values in their original unit", () => {
    expect(formatTrajectoryDuration(null)).toBe("—");
    expect(formatTrajectoryDuration(0)).toBe("0ms");
    expect(formatTrajectoryDuration(999)).toBe("999ms");
    expect(formatTrajectoryDuration(1000)).toBe("1.0s");
    expect(formatTrajectoryDuration(59_949)).toBe("59.9s");
  });

  it("promotes to minutes when rounding reaches the 60s boundary", () => {
    expect(formatTrajectoryDuration(59_950)).toBe("1.0m");
    expect(formatTrajectoryDuration(59_994)).toBe("1.0m");
    expect(formatTrajectoryDuration(59_999)).toBe("1.0m");
    expect(formatTrajectoryDuration(60_000)).toBe("1.0m");
    expect(formatTrajectoryDuration(90_000)).toBe("1.5m");
  });
});

describe("formatTrajectoryTokenCount", () => {
  const options = { emptyLabel: "—" };

  it("keeps sub-boundary values in their original unit", () => {
    expect(formatTrajectoryTokenCount(undefined, options)).toBe("—");
    expect(formatTrajectoryTokenCount(0, options)).toBe("—");
    expect(formatTrajectoryTokenCount(999, options)).toBe("999");
    expect(formatTrajectoryTokenCount(1000, options)).toBe("1.0k");
    expect(formatTrajectoryTokenCount(999_500, options)).toBe("999.5k");
    expect(formatTrajectoryTokenCount(999_949, options)).toBe("999.9k");
  });

  it("promotes to the M tier when rounding reaches the 1000k boundary", () => {
    expect(formatTrajectoryTokenCount(999_950, options)).toBe("1.0M");
    expect(formatTrajectoryTokenCount(1_000_000, options)).toBe("1.0M");
    expect(formatTrajectoryTokenCount(2_500_000, options)).toBe("2.5M");
  });
});
