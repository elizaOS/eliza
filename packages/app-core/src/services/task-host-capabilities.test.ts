/**
 * Unit test coverage for getHostExecutionCapabilities and
 * describeHostExecutionCapabilities in task-host-capabilities.ts.
 *
 * Exercises execution profile detection across Node desktop, pure browser,
 * Capacitor native environments, BackgroundRunner plugin presence, iOS
 * ElizaTasks plugin, and Android Foreground Service (FGS) setting states.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeHostExecutionCapabilities,
  getHostExecutionCapabilities,
} from "./task-host-capabilities.js";

function createMockRuntime(
  settings: Record<string, unknown> = {},
): IAgentRuntime {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe("task-host-capabilities", () => {
  const originalCapacitor = Reflect.get(globalThis, "Capacitor");

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, "Capacitor");
  });

  afterEach(() => {
    if (originalCapacitor !== undefined) {
      Reflect.set(globalThis, "Capacitor", originalCapacitor);
    } else {
      Reflect.deleteProperty(globalThis, "Capacitor");
    }
  });

  describe("getHostExecutionCapabilities", () => {
    it("returns all four profiles on Node desktop / non-Capacitor environment", () => {
      const runtime = createMockRuntime();
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-light-30s", "bg-heavy-fgs"]),
      );
    });

    it("returns all four profiles when Capacitor object is present but isNativePlatform returns false", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => false,
        Plugins: {},
      });

      const runtime = createMockRuntime();
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-light-30s", "bg-heavy-fgs"]),
      );
    });

    it("returns only foreground and notify-only on pure native Capacitor without extra plugins or active FGS", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {},
      });

      const runtime = createMockRuntime();
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(new Set(["foreground", "notify-only"]));
    });

    it("includes bg-light-30s when Capacitor BackgroundRunner plugin is present", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {
          BackgroundRunner: {},
        },
      });

      const runtime = createMockRuntime();
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-light-30s"]),
      );
    });

    it("includes bg-heavy-fgs when Capacitor ElizaTasks plugin (iOS BGProcessingTask) is present", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {
          ElizaTasks: {},
        },
      });

      const runtime = createMockRuntime();
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-heavy-fgs"]),
      );
    });

    it("includes bg-heavy-fgs when Android FGS is active via string '1'", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {},
      });

      const runtime = createMockRuntime({
        ELIZA_HOST_FGS_ACTIVE: "1",
      });
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-heavy-fgs"]),
      );
    });

    it("includes bg-heavy-fgs when Android FGS is active via boolean true", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {},
      });

      const runtime = createMockRuntime({
        ELIZA_HOST_FGS_ACTIVE: true,
      });
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-heavy-fgs"]),
      );
    });

    it("includes all profiles when both BackgroundRunner and ElizaTasks plugins are present", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {
          BackgroundRunner: {},
          ElizaTasks: {},
        },
      });

      const runtime = createMockRuntime();
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(
        new Set(["foreground", "notify-only", "bg-light-30s", "bg-heavy-fgs"]),
      );
    });

    it("handles runtime without getSetting method safely", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {},
      });

      const runtime = {} as unknown as IAgentRuntime;
      const capabilities = getHostExecutionCapabilities(runtime);

      expect(capabilities).toEqual(new Set(["foreground", "notify-only"]));
    });
  });

  describe("describeHostExecutionCapabilities", () => {
    it("returns correct structured diagnostic object for non-Capacitor environment", () => {
      const runtime = createMockRuntime();
      const description = describeHostExecutionCapabilities(runtime);

      expect(description).toEqual({
        profiles: ["foreground", "notify-only", "bg-light-30s", "bg-heavy-fgs"],
        isCapacitor: false,
        hasBackgroundRunner: false,
        hasElizaTasksPlugin: false,
        fgsActive: false,
      });
    });

    it("returns correct structured diagnostic object for native Capacitor with all capabilities", () => {
      Reflect.set(globalThis, "Capacitor", {
        isNativePlatform: () => true,
        Plugins: {
          BackgroundRunner: {},
          ElizaTasks: {},
        },
      });

      const runtime = createMockRuntime({
        ELIZA_HOST_FGS_ACTIVE: "1",
      });
      const description = describeHostExecutionCapabilities(runtime);

      expect(description).toEqual({
        profiles: ["foreground", "notify-only", "bg-light-30s", "bg-heavy-fgs"],
        isCapacitor: true,
        hasBackgroundRunner: true,
        hasElizaTasksPlugin: true,
        fgsActive: true,
      });
    });
  });
});
