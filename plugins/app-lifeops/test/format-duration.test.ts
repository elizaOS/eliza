import { describe, expect, it } from "vitest";
import { formatMinutesDuration } from "../src/utils/format-duration.js";

describe("formatMinutesDuration", () => {
  it("renders sub-hour values as bare minutes", () => {
    expect(formatMinutesDuration(0)).toBe("0m");
    expect(formatMinutesDuration(1)).toBe("1m");
    expect(formatMinutesDuration(45)).toBe("45m");
    expect(formatMinutesDuration(59)).toBe("59m");
  });

  it("renders exact hour values without a minute tail", () => {
    expect(formatMinutesDuration(60)).toBe("1h");
    expect(formatMinutesDuration(120)).toBe("2h");
    expect(formatMinutesDuration(1440)).toBe("24h");
  });

  it("renders hour+minute values", () => {
    expect(formatMinutesDuration(90)).toBe("1h 30m");
    expect(formatMinutesDuration(450)).toBe("7h 30m");
    expect(formatMinutesDuration(1076)).toBe("17h 56m");
    expect(formatMinutesDuration(1354)).toBe("22h 34m");
  });

  it("rounds fractional minutes to the nearest minute", () => {
    expect(formatMinutesDuration(59.4)).toBe("59m");
    expect(formatMinutesDuration(59.6)).toBe("1h");
    expect(formatMinutesDuration(90.4)).toBe("1h 30m");
  });

  it("clamps negative inputs to zero", () => {
    expect(formatMinutesDuration(-10)).toBe("0m");
    expect(formatMinutesDuration(-0.5)).toBe("0m");
  });
});
