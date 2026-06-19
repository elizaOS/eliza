import { describe, expect, it } from "vitest";
import { buildDeviceBridgeStatusStreamUrl } from "./useDeviceBridgeStatus";

describe("buildDeviceBridgeStatusStreamUrl", () => {
  it("adds trimmed token with the right query separator", () => {
    expect(buildDeviceBridgeStatusStreamUrl("/stream", " token value ")).toBe(
      "/stream?token=token%20value",
    );
    expect(buildDeviceBridgeStatusStreamUrl("/stream?existing=1", "abc")).toBe(
      "/stream?existing=1&token=abc",
    );
  });

  it("leaves url unchanged when token is absent", () => {
    expect(buildDeviceBridgeStatusStreamUrl("/stream", "")).toBe("/stream");
    expect(buildDeviceBridgeStatusStreamUrl("/stream", null)).toBe("/stream");
  });
});
