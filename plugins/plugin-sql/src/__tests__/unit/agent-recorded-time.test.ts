import { describe, expect, it } from "vitest";
import { agentRecordedTime } from "../../agent-recorded-time";

describe("agentRecordedTime", () => {
  it("keeps an explicit epoch timestamp", () => {
    expect(agentRecordedTime(0, 1_700_000_000_000)).toBe(0);
    expect(agentRecordedTime(0n, 1_700_000_000_000)).toBe(0);
  });

  it("uses now when the timestamp was omitted", () => {
    expect(agentRecordedTime(undefined, 1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(agentRecordedTime(Number.NaN, 1_700_000_000_000)).toBe(1_700_000_000_000);
  });
});
