import { describe, expect, it } from "vitest";
import { OWNER_LOCAL_TZ, resolveTriggerTz } from "./trigger-tz.ts";

describe("resolveTriggerTz", () => {
  it("resolves owner_local to the owner timezone", () => {
    expect(
      resolveTriggerTz(OWNER_LOCAL_TZ, { timezone: "Asia/Shanghai" }),
    ).toBe("Asia/Shanghai");
  });

  it("falls back to UTC when the owner has no timezone", () => {
    expect(resolveTriggerTz(OWNER_LOCAL_TZ, undefined)).toBe("UTC");
    expect(resolveTriggerTz(OWNER_LOCAL_TZ, {})).toBe("UTC");
  });

  it("passes concrete zones through unchanged", () => {
    expect(resolveTriggerTz("America/New_York", undefined)).toBe(
      "America/New_York",
    );
  });
});
