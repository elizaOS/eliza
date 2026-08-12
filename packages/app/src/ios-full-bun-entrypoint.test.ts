/** Pins the native bridge ordering and web no-op for the headless iOS smoke. */
import { describe, expect, it, vi } from "vitest";
import { runIosFullBunEntrypoint } from "./ios-full-bun-entrypoint";

function dependencies(
  isIOS: boolean,
  { fullBunAvailable = true, runResult = true } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      isIOS,
      fullBunAvailable,
      initializeStorageBridge: vi.fn(async () => {
        calls.push("storage");
      }),
      initializeCapacitorBridge: vi.fn(() => calls.push("capacitor")),
      installNativeRequestBridge: vi.fn(() => calls.push("native-request")),
      installFetchBridge: vi.fn(() => calls.push("fetch")),
      runSmoke: vi.fn(async ({ fullBunAvailable: available }) => {
        calls.push(`smoke:${String(available)}`);
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
      "smoke:true",
    ]);
  });

  it("does no native work outside iOS", async () => {
    const fixture = dependencies(false);
    await expect(runIosFullBunEntrypoint(fixture.value)).resolves.toBe(false);
    expect(fixture.calls).toEqual([]);
  });

  it("returns false when no smoke request takes ownership", async () => {
    const fixture = dependencies(true, { runResult: false });
    await expect(runIosFullBunEntrypoint(fixture.value)).resolves.toBe(false);
    expect(fixture.calls.at(-1)).toBe("smoke:true");
  });

  it("clears the request before storage can hydrate persisted local mode in a no-engine build", async () => {
    const fixture = dependencies(true, {
      fullBunAvailable: false,
      runResult: true,
    });

    await expect(runIosFullBunEntrypoint(fixture.value)).resolves.toBe(false);
    expect(fixture.calls).toEqual(["smoke:false"]);
    expect(fixture.value.runSmoke).toHaveBeenCalledWith({
      fullBunAvailable: false,
    });
  });
});
