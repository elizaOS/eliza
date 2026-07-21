/** Pins the native bridge ordering and web no-op for the headless iOS smoke. */
import { describe, expect, it, vi } from "vitest";
import { runIosFullBunEntrypoint } from "./ios-full-bun-entrypoint";

function dependencies(isIOS: boolean, runResult = true) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      isIOS,
      initializeStorageBridge: vi.fn(async () => {
        calls.push("storage");
      }),
      initializeCapacitorBridge: vi.fn(() => calls.push("capacitor")),
      installNativeRequestBridge: vi.fn(() => calls.push("native-request")),
      installFetchBridge: vi.fn(() => calls.push("fetch")),
      runSmoke: vi.fn(async () => {
        calls.push("smoke");
        return runResult;
      }),
    },
  };
}

describe("iOS full-Bun entrypoint", () => {
  it("hydrates storage and installs both bridges before the smoke", async () => {
    const fixture = dependencies(true);
    await expect(runIosFullBunEntrypoint(fixture.value)).resolves.toBe(true);
    expect(fixture.calls).toEqual([
      "storage",
      "capacitor",
      "native-request",
      "fetch",
      "smoke",
    ]);
  });

  it("does no native work outside iOS", async () => {
    const fixture = dependencies(false);
    await expect(runIosFullBunEntrypoint(fixture.value)).resolves.toBe(false);
    expect(fixture.calls).toEqual([]);
  });

  it("returns false when no smoke request takes ownership", async () => {
    const fixture = dependencies(true, false);
    await expect(runIosFullBunEntrypoint(fixture.value)).resolves.toBe(false);
    expect(fixture.calls.at(-1)).toBe("smoke");
  });
});
