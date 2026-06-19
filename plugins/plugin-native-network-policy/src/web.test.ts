import { afterEach, describe, expect, it } from "vitest";

import { NetworkPolicyWeb } from "./web";

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value,
  });
}

describe("NetworkPolicyWeb fallback", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: undefined,
    });
  });

  it("treats browser saveData=true as metered and constrained", async () => {
    setNavigator({ connection: { saveData: true } });
    const policy = new NetworkPolicyWeb();

    await expect(policy.getMeteredHint()).resolves.toEqual({
      metered: true,
      source: "android-os",
    });
    await expect(policy.getPathHints()).resolves.toEqual({
      isExpensive: true,
      isConstrained: true,
      source: "nw-path-monitor",
    });
  });

  it.each([
    undefined,
    {},
    { connection: null },
    { connection: { saveData: false } },
    { connection: { saveData: "true" } },
    { connection: { saveData: 1 } },
  ])("falls back conservatively for navigator shape %#", async (navigatorLike) => {
    setNavigator(navigatorLike);
    const policy = new NetworkPolicyWeb();

    await expect(policy.getMeteredHint()).resolves.toEqual({
      metered: null,
      source: "android-os",
    });
    await expect(policy.getPathHints()).resolves.toEqual({
      isExpensive: false,
      isConstrained: false,
      source: "nw-path-monitor",
    });
  });
});
