/**
 * Unit tests for the React-free AOSP ElizaOS detection surface that Node
 * update-policy code depends on (moved here from `@elizaos/ui/platform` in
 * #12410).
 */

import { afterEach, describe, expect, it } from "vitest";
import { isElizaOS, userAgentHasElizaOSMarker } from "./eliza-os.js";

describe("userAgentHasElizaOSMarker", () => {
  it("matches the framework marker on AOSP ElizaOS system images", () => {
    expect(userAgentHasElizaOSMarker("Mozilla/5.0 ElizaOS/2.0.4 (Linux)")).toBe(
      true,
    );
  });

  it("rejects stock Android, empty, and non-string user agents", () => {
    expect(userAgentHasElizaOSMarker("Mozilla/5.0 (Linux; Android 14)")).toBe(
      false,
    );
    expect(userAgentHasElizaOSMarker("")).toBe(false);
    expect(userAgentHasElizaOSMarker(null)).toBe(false);
    expect(userAgentHasElizaOSMarker(undefined)).toBe(false);
  });
});

describe("isElizaOS", () => {
  const originalNavigator = Reflect.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  it("is true when navigator.userAgent carries the marker", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 ElizaOS/2.0 (Linux; Android 14)" },
    });
    expect(isElizaOS()).toBe(true);
  });

  it("is false for a stock user agent", () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { userAgent: "Mozilla/5.0 (Linux; Android 14)" },
    });
    expect(isElizaOS()).toBe(false);
  });
});
