import { describe, expect, it } from "vitest";
import {
  isAospElizaUserAgent,
  userAgentHasElizaOSMarker,
} from "../aosp-user-agent.ts";

describe("userAgentHasElizaOSMarker", () => {
  it("detects the ElizaOS marker", () => {
    expect(userAgentHasElizaOSMarker("Mozilla/5.0 ElizaOS/1.2.3 Android")).toBe(
      true,
    );
  });

  it("rejects missing or malformed markers", () => {
    expect(userAgentHasElizaOSMarker("Mozilla/5.0 Android")).toBe(false);
    expect(userAgentHasElizaOSMarker("ElizaOS/")).toBe(false);
    expect(userAgentHasElizaOSMarker(null)).toBe(false);
    expect(userAgentHasElizaOSMarker(undefined)).toBe(false);
    expect(userAgentHasElizaOSMarker("")).toBe(false);
  });
});

describe("isAospElizaUserAgent", () => {
  it("aliases the marker check", () => {
    expect(isAospElizaUserAgent("ElizaOS/x")).toBe(true);
    expect(isAospElizaUserAgent("plain")).toBe(false);
  });
});
