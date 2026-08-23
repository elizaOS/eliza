/**
 * Unit tests for getHostExecutionCapabilities and
 * describeHostExecutionCapabilities: the host profile probe that reads
 * `globalThis.Capacitor` plus `runtime.getSetting("ELIZA_HOST_FGS_ACTIVE")`.
 * Drives the real module. Capacitor is installed on globalThis and restored
 * after each case. Assertions record observed probe rules, including where
 * `describeHostExecutionCapabilities` plugin flags are looser than the Set
 * returned by `getHostExecutionCapabilities`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeHostExecutionCapabilities,
  getHostExecutionCapabilities,
} from "./task-host-capabilities";

const DESKTOP_PROFILES = [
  "foreground",
  "notify-only",
  "bg-light-30s",
  "bg-heavy-fgs",
] as const;

const NATIVE_BASE_PROFILES = ["foreground", "notify-only"] as const;

const CAPACITOR_KEY = "Capacitor";

let previousCapacitorPresent = false;
let previousCapacitorValue: unknown;

function runtimeWithoutGetSetting(): IAgentRuntime {
  return {} as unknown as IAgentRuntime;
}

function runtimeWithSetting(value: unknown): IAgentRuntime {
  return {
    getSetting(key: string) {
      return key === "ELIZA_HOST_FGS_ACTIVE" ? value : undefined;
    },
  } as unknown as IAgentRuntime;
}

function runtimeRecordingSetting(value: unknown): {
  runtime: IAgentRuntime;
  keys: string[];
} {
  const keys: string[] = [];
  const runtime = {
    getSetting(key: string) {
      keys.push(key);
      return value;
    },
  } as unknown as IAgentRuntime;
  return { runtime, keys };
}

function setCapacitor(value: unknown): void {
  Reflect.set(globalThis, CAPACITOR_KEY, value);
}

function nativeCapacitor(plugins?: unknown): Record<string, unknown> {
  const capacitor: Record<string, unknown> = {
    isNativePlatform: () => true,
  };
  if (plugins !== undefined) {
    capacitor.Plugins = plugins;
  }
  return capacitor;
}

function profileList(profiles: ReadonlySet<string>): readonly string[] {
  return Array.from(profiles);
}

describe("getHostExecutionCapabilities / describeHostExecutionCapabilities", () => {
  beforeEach(() => {
    previousCapacitorPresent = Object.hasOwn(globalThis, CAPACITOR_KEY);
    previousCapacitorValue = Reflect.get(globalThis, CAPACITOR_KEY);
    Reflect.deleteProperty(globalThis, CAPACITOR_KEY);
  });

  afterEach(() => {
    if (previousCapacitorPresent) {
      Reflect.set(globalThis, CAPACITOR_KEY, previousCapacitorValue);
    } else {
      Reflect.deleteProperty(globalThis, CAPACITOR_KEY);
    }
  });

  describe("non-native hosts (Node desktop / missing Capacitor)", () => {
    it("treats an absent Capacitor global as desktop and returns all four profiles in insertion order", () => {
      const profiles = getHostExecutionCapabilities(runtimeWithoutGetSetting());
      expect(profileList(profiles)).toEqual([...DESKTOP_PROFILES]);
      expect(profiles.size).toBe(4);
    });

    it("treats a null Capacitor global as desktop", () => {
      setCapacitor(null);
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("treats a non-object Capacitor global as desktop", () => {
      setCapacitor("capacitor");
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("treats Capacitor without an isNativePlatform function as desktop", () => {
      setCapacitor({ Plugins: { BackgroundRunner: {} } });
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("treats isNativePlatform that is not a function as desktop", () => {
      setCapacitor({ isNativePlatform: true });
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("treats isNativePlatform() === false as desktop, not as a native host", () => {
      setCapacitor({
        isNativePlatform: () => false,
        Plugins: { BackgroundRunner: {}, ElizaTasks: {} },
      });
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("requires isNativePlatform() === true; a truthy non-true return is desktop", () => {
      setCapacitor({ isNativePlatform: () => 1 });
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("does not consult getSetting on the desktop path", () => {
      const { runtime, keys } = runtimeRecordingSetting("1");
      expect(profileList(getHostExecutionCapabilities(runtime))).toEqual([
        ...DESKTOP_PROFILES,
      ]);
      expect(keys).toEqual([]);
    });

    it("returns independent Sets so later mutation cannot leak across calls", () => {
      const first = getHostExecutionCapabilities(runtimeWithoutGetSetting());
      const second = getHostExecutionCapabilities(runtimeWithoutGetSetting());
      expect(first).not.toBe(second);
      (first as Set<(typeof DESKTOP_PROFILES)[number]>).delete("foreground");
      expect(first.has("foreground")).toBe(false);
      expect(second.has("foreground")).toBe(true);
      expect(profileList(second)).toEqual([...DESKTOP_PROFILES]);
    });

    it("describeHostExecutionCapabilities reports desktop flags even when FGS setting is set", () => {
      const snapshot = describeHostExecutionCapabilities(
        runtimeWithSetting("1"),
      );
      expect(snapshot.profiles).toEqual([...DESKTOP_PROFILES]);
      expect(snapshot.isCapacitor).toBe(false);
      expect(snapshot.hasBackgroundRunner).toBe(false);
      expect(snapshot.hasElizaTasksPlugin).toBe(false);
      // Observed: the snapshot still reads ELIZA_HOST_FGS_ACTIVE off the
      // desktop path, even though getHostExecutionCapabilities ignores it.
      expect(snapshot.fgsActive).toBe(true);
    });

    it("describeHostExecutionCapabilities reports fgsActive false when the setting is absent on desktop", () => {
      const snapshot = describeHostExecutionCapabilities(
        runtimeWithoutGetSetting(),
      );
      expect(snapshot.fgsActive).toBe(false);
      expect(snapshot.isCapacitor).toBe(false);
    });
  });

  describe("native Capacitor hosts", () => {
    it("returns only foreground + notify-only when native with no plugins and no FGS", () => {
      setCapacitor(nativeCapacitor());
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);
    });

    it("returns only the base pair when Plugins is missing, null, or a non-object", () => {
      setCapacitor(nativeCapacitor(null));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);

      setCapacitor({
        isNativePlatform: () => true,
        Plugins: "not-an-object",
      });
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);
    });

    it("adds bg-light-30s when BackgroundRunner is a non-null object", () => {
      setCapacitor(nativeCapacitor({ BackgroundRunner: {} }));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual(["foreground", "notify-only", "bg-light-30s"]);
    });

    it("does not add bg-light-30s when BackgroundRunner is a non-object handle", () => {
      setCapacitor(nativeCapacitor({ BackgroundRunner: "present" }));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);
    });

    it("does not add bg-light-30s when BackgroundRunner is null", () => {
      setCapacitor(nativeCapacitor({ BackgroundRunner: null }));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);
    });

    it("adds bg-heavy-fgs when ElizaTasks is a non-null object", () => {
      setCapacitor(nativeCapacitor({ ElizaTasks: {} }));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual(["foreground", "notify-only", "bg-heavy-fgs"]);
    });

    it("does not add bg-heavy-fgs when ElizaTasks is a non-object handle", () => {
      setCapacitor(nativeCapacitor({ ElizaTasks: "present" }));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);
    });

    it("adds bg-heavy-fgs when ELIZA_HOST_FGS_ACTIVE is the string '1'", () => {
      setCapacitor(nativeCapacitor());
      const { runtime, keys } = runtimeRecordingSetting("1");
      expect(profileList(getHostExecutionCapabilities(runtime))).toEqual([
        "foreground",
        "notify-only",
        "bg-heavy-fgs",
      ]);
      expect(keys).toEqual(["ELIZA_HOST_FGS_ACTIVE"]);
    });

    it("adds bg-heavy-fgs when ELIZA_HOST_FGS_ACTIVE is boolean true", () => {
      setCapacitor(nativeCapacitor());
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithSetting(true))),
      ).toEqual(["foreground", "notify-only", "bg-heavy-fgs"]);
    });

    it("does not treat nearby FGS values as active (number 1, 'true', '0', false)", () => {
      setCapacitor(nativeCapacitor());
      for (const value of [1, "true", "0", false, "1 ", undefined]) {
        expect(
          profileList(getHostExecutionCapabilities(runtimeWithSetting(value))),
          `FGS value ${String(value)}`,
        ).toEqual([...NATIVE_BASE_PROFILES]);
      }
    });

    it("skips FGS when getSetting is missing or not a function", () => {
      setCapacitor(nativeCapacitor());
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithoutGetSetting())),
      ).toEqual([...NATIVE_BASE_PROFILES]);
      expect(
        profileList(
          getHostExecutionCapabilities({
            getSetting: "1",
          } as unknown as IAgentRuntime),
        ),
      ).toEqual([...NATIVE_BASE_PROFILES]);
    });

    it("adds bg-heavy-fgs once when both ElizaTasks and FGS are present", () => {
      setCapacitor(nativeCapacitor({ ElizaTasks: {} }));
      const profiles = getHostExecutionCapabilities(runtimeWithSetting("1"));
      expect(profileList(profiles)).toEqual([
        "foreground",
        "notify-only",
        "bg-heavy-fgs",
      ]);
      expect(profiles.size).toBe(3);
    });

    it("returns all four profiles when BackgroundRunner and FGS/ElizaTasks are present", () => {
      setCapacitor(nativeCapacitor({ BackgroundRunner: {}, ElizaTasks: {} }));
      expect(
        profileList(getHostExecutionCapabilities(runtimeWithSetting("1"))),
      ).toEqual([...DESKTOP_PROFILES]);
    });

    it("describeHostExecutionCapabilities mirrors native plugin + FGS flags", () => {
      setCapacitor(nativeCapacitor({ BackgroundRunner: {}, ElizaTasks: {} }));
      const snapshot = describeHostExecutionCapabilities(
        runtimeWithSetting("1"),
      );
      expect(snapshot).toEqual({
        profiles: [...DESKTOP_PROFILES],
        isCapacitor: true,
        hasBackgroundRunner: true,
        hasElizaTasksPlugin: true,
        fgsActive: true,
      });
    });

    it("describeHostExecutionCapabilities reports looser plugin flags than getHost for primitive handles", () => {
      setCapacitor(
        nativeCapacitor({
          BackgroundRunner: "runner",
          ElizaTasks: "tasks",
        }),
      );
      const runtime = runtimeWithoutGetSetting();
      const profiles = getHostExecutionCapabilities(runtime);
      const snapshot = describeHostExecutionCapabilities(runtime);

      // Observed: getHost requires typeof handle === "object"; describe
      // only checks != null, so primitive handles flag true without adding
      // the matching profile.
      expect(profileList(profiles)).toEqual([...NATIVE_BASE_PROFILES]);
      expect(snapshot.profiles).toEqual([...NATIVE_BASE_PROFILES]);
      expect(snapshot.isCapacitor).toBe(true);
      expect(snapshot.hasBackgroundRunner).toBe(true);
      expect(snapshot.hasElizaTasksPlugin).toBe(true);
      expect(snapshot.fgsActive).toBe(false);
    });

    it("describeHostExecutionCapabilities reports false plugin flags when Plugins is omitted", () => {
      setCapacitor(nativeCapacitor());
      const snapshot = describeHostExecutionCapabilities(
        runtimeWithoutGetSetting(),
      );
      expect(snapshot.isCapacitor).toBe(true);
      expect(snapshot.hasBackgroundRunner).toBe(false);
      expect(snapshot.hasElizaTasksPlugin).toBe(false);
      expect(snapshot.profiles).toEqual([...NATIVE_BASE_PROFILES]);
    });
  });
});
