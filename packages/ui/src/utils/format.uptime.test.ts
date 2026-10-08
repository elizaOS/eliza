import { describe, expect, it } from "vitest";
import { formatUptime } from "./format.ts";

describe("formatUptime", () => {
  it("keeps leftover seconds under a minute", () => {
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(90, true)).toBe("1m 30s");
    expect(formatUptime(60)).toBe("1m");
    expect(formatUptime(59)).toBe("59s");
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(3600)).toBe("1h 0m");
    expect(formatUptime(3661, true)).toBe("1h 1m 1s");
  });
});
