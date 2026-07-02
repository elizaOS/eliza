import { describe, expect, it } from "vitest";
import {
  hasPersistedActiveServer,
  readFirstRunComplete,
  reconcileIosLocalBuildRuntimeMode,
  shouldResetPoisonedIosRuntimeMode,
} from "./ios-runtime-mode-reconcile";

function fakeStorage(
  entries: Record<string, string>,
): Pick<Storage, "getItem"> {
  return {
    getItem: (key: string) => entries[key] ?? null,
  };
}

describe("shouldResetPoisonedIosRuntimeMode", () => {
  const poisoned = {
    isNativeIos: true,
    bakedRuntimeMode: "local",
    persistedMode: "cloud",
    hasPersistedActiveServer: false,
    firstRunComplete: false,
  };

  it("resets the exact #11030 poisoned state: local build, persisted cloud, no active server", () => {
    expect(shouldResetPoisonedIosRuntimeMode(poisoned)).toBe(true);
    expect(
      shouldResetPoisonedIosRuntimeMode({
        ...poisoned,
        persistedMode: "cloud-hybrid",
      }),
    ).toBe(true);
  });

  it("never touches non-iOS platforms", () => {
    expect(
      shouldResetPoisonedIosRuntimeMode({ ...poisoned, isNativeIos: false }),
    ).toBe(false);
  });

  it("never touches builds that do not bake runtimeMode=local", () => {
    expect(
      shouldResetPoisonedIosRuntimeMode({
        ...poisoned,
        bakedRuntimeMode: "cloud-hybrid",
      }),
    ).toBe(false);
    expect(
      shouldResetPoisonedIosRuntimeMode({
        ...poisoned,
        bakedRuntimeMode: "cloud",
      }),
    ).toBe(false);
  });

  it("respects a committed cloud choice (active server present)", () => {
    expect(
      shouldResetPoisonedIosRuntimeMode({
        ...poisoned,
        hasPersistedActiveServer: true,
      }),
    ).toBe(false);
  });

  it("respects a completed first-run even without an active server", () => {
    expect(
      shouldResetPoisonedIosRuntimeMode({
        ...poisoned,
        firstRunComplete: true,
      }),
    ).toBe(false);
  });

  it("leaves explicit non-cloud modes and clean states alone", () => {
    for (const persistedMode of [
      "local",
      "remote-mac",
      "tunnel-to-mobile",
      null,
      "garbage",
    ]) {
      expect(
        shouldResetPoisonedIosRuntimeMode({ ...poisoned, persistedMode }),
      ).toBe(false);
    }
  });
});

describe("hasPersistedActiveServer", () => {
  it("detects a committed active server", () => {
    expect(
      hasPersistedActiveServer(
        fakeStorage({
          "elizaos:active-server": JSON.stringify({
            id: "cloud:me",
            kind: "cloud",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("rejects missing, malformed, and id-less payloads", () => {
    expect(hasPersistedActiveServer(fakeStorage({}))).toBe(false);
    expect(
      hasPersistedActiveServer(
        fakeStorage({ "elizaos:active-server": "not json" }),
      ),
    ).toBe(false);
    expect(
      hasPersistedActiveServer(
        fakeStorage({ "elizaos:active-server": JSON.stringify({ id: "" }) }),
      ),
    ).toBe(false);
    expect(hasPersistedActiveServer(null)).toBe(false);
  });
});

describe("readFirstRunComplete", () => {
  it("reads the canonical '1' flag (and tolerates 'true')", () => {
    expect(
      readFirstRunComplete(fakeStorage({ "eliza:first-run-complete": "1" })),
    ).toBe(true);
    expect(
      readFirstRunComplete(fakeStorage({ "eliza:first-run-complete": "true" })),
    ).toBe(true);
    expect(readFirstRunComplete(fakeStorage({}))).toBe(false);
    expect(readFirstRunComplete(null)).toBe(false);
  });
});

describe("reconcileIosLocalBuildRuntimeMode", () => {
  it("is a no-op when first-run already completed", () => {
    const persisted: string[] = [];
    const reset = reconcileIosLocalBuildRuntimeMode({
      isNativeIos: true,
      bakedRuntimeMode: "local",
      storage: fakeStorage({
        "eliza:mobile-runtime-mode": "cloud",
        "eliza:first-run-complete": "1",
      }),
      persistLocalMode: () => persisted.push("local"),
      log: () => {},
    });
    expect(reset).toBe(false);
    expect(persisted).toEqual([]);
  });

  it("persists local mode and logs when the poisoned state is detected", () => {
    const persisted: string[] = [];
    const logs: string[] = [];
    const reset = reconcileIosLocalBuildRuntimeMode({
      isNativeIos: true,
      bakedRuntimeMode: "local",
      storage: fakeStorage({ "eliza:mobile-runtime-mode": "cloud" }),
      persistLocalMode: () => persisted.push("local"),
      log: (message) => logs.push(message),
    });
    expect(reset).toBe(true);
    expect(persisted).toEqual(["local"]);
    expect(logs[0]).toMatch(/'cloud' → 'local'/);
    expect(logs[0]).toMatch(/#11030/);
  });

  it("is a no-op on healthy state", () => {
    const persisted: string[] = [];
    const reset = reconcileIosLocalBuildRuntimeMode({
      isNativeIos: true,
      bakedRuntimeMode: "local",
      storage: fakeStorage({ "eliza:mobile-runtime-mode": "local" }),
      persistLocalMode: () => persisted.push("local"),
      log: () => {},
    });
    expect(reset).toBe(false);
    expect(persisted).toEqual([]);
  });

  it("is a no-op when the user committed a cloud server", () => {
    const persisted: string[] = [];
    const reset = reconcileIosLocalBuildRuntimeMode({
      isNativeIos: true,
      bakedRuntimeMode: "local",
      storage: fakeStorage({
        "eliza:mobile-runtime-mode": "cloud",
        "elizaos:active-server": JSON.stringify({
          id: "cloud:me",
          kind: "cloud",
        }),
      }),
      persistLocalMode: () => persisted.push("local"),
      log: () => {},
    });
    expect(reset).toBe(false);
    expect(persisted).toEqual([]);
  });

  it("tolerates a throwing storage", () => {
    const reset = reconcileIosLocalBuildRuntimeMode({
      isNativeIos: true,
      bakedRuntimeMode: "local",
      storage: {
        getItem: () => {
          throw new Error("storage unavailable");
        },
      },
      persistLocalMode: () => {
        throw new Error("should not persist");
      },
      log: () => {},
    });
    expect(reset).toBe(false);
  });
});
