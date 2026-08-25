/**
 * Behavioral coverage for the agent `local-execution-mode` re-export shim.
 * Drives the real resolvers through this historical import path: setting-key
 * order, env fallback, invalid/empty/non-string values, default mode, iOS
 * local-yolo clamp, and the local-safe / sandbox / cloud helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCloudExecutionMode,
  type RuntimeExecutionModeSource,
  resolveLocalExecutionMode,
  resolveRuntimeExecutionMode,
  shouldUseSandboxExecution,
} from "./local-execution-mode.ts";

const SETTING_KEYS = [
  "ELIZA_RUNTIME_MODE",
  "RUNTIME_MODE",
  "LOCAL_RUNTIME_MODE",
] as const;

function sourceFrom(
  values: Partial<Record<(typeof SETTING_KEYS)[number], unknown>>,
): RuntimeExecutionModeSource {
  return {
    getSetting: (key: string) => values[key as (typeof SETTING_KEYS)[number]],
  };
}

function recordingSource(
  values: Partial<Record<(typeof SETTING_KEYS)[number], unknown>>,
): { source: RuntimeExecutionModeSource; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    source: {
      getSetting: (key: string) => {
        keys.push(key);
        return values[key as (typeof SETTING_KEYS)[number]];
      },
    },
  };
}

describe("local-execution-mode", () => {
  beforeEach(() => {
    vi.stubEnv("ELIZA_RUNTIME_MODE", undefined);
    vi.stubEnv("RUNTIME_MODE", undefined);
    vi.stubEnv("LOCAL_RUNTIME_MODE", undefined);
    vi.stubEnv("ELIZA_PLATFORM", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("resolveRuntimeExecutionMode", () => {
    it("defaults to local-yolo when the source and env queue are empty", () => {
      expect(resolveRuntimeExecutionMode()).toBe("local-yolo");
      expect(resolveRuntimeExecutionMode(null)).toBe("local-yolo");
      expect(resolveRuntimeExecutionMode(undefined)).toBe("local-yolo");
      expect(resolveRuntimeExecutionMode({})).toBe("local-yolo");
    });

    it("reads a single present setting and ignores later empty keys", () => {
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "cloud" }),
        ),
      ).toBe("cloud");
    });

    it("prefers earlier setting keys over later ones when several are set", () => {
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({
            ELIZA_RUNTIME_MODE: "local-safe",
            RUNTIME_MODE: "cloud",
            LOCAL_RUNTIME_MODE: "local-yolo",
          }),
        ),
      ).toBe("local-safe");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({
            RUNTIME_MODE: "cloud",
            LOCAL_RUNTIME_MODE: "local-yolo",
          }),
        ),
      ).toBe("cloud");
    });

    it("treats a tied three-key setting as the first key's value", () => {
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({
            ELIZA_RUNTIME_MODE: "local-yolo",
            RUNTIME_MODE: "local-yolo",
            LOCAL_RUNTIME_MODE: "local-yolo",
          }),
        ),
      ).toBe("local-yolo");
    });

    it("skips invalid, blank, and non-string settings and continues the queue", () => {
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({
            ELIZA_RUNTIME_MODE: "not-a-mode",
            RUNTIME_MODE: "  ",
            LOCAL_RUNTIME_MODE: "local-safe",
          }),
        ),
      ).toBe("local-safe");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({
            ELIZA_RUNTIME_MODE: 42,
            RUNTIME_MODE: null,
            LOCAL_RUNTIME_MODE: "cloud",
          }),
        ),
      ).toBe("cloud");
    });

    it("normalizes setting values by trimming and lowercasing", () => {
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "  CLOUD  " }),
        ),
      ).toBe("cloud");
      expect(
        resolveRuntimeExecutionMode(sourceFrom({ RUNTIME_MODE: "Local-Safe" })),
      ).toBe("local-safe");
    });

    it("consults setting keys in documented order before reading env", () => {
      const { source, keys } = recordingSource({
        LOCAL_RUNTIME_MODE: "cloud",
      });
      vi.stubEnv("ELIZA_RUNTIME_MODE", "local-yolo");

      expect(resolveRuntimeExecutionMode(source)).toBe("cloud");
      expect(keys).toEqual([...SETTING_KEYS]);
    });

    it("does not fall through to env while a later setting is still valid", () => {
      vi.stubEnv("ELIZA_RUNTIME_MODE", "cloud");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({
            ELIZA_RUNTIME_MODE: "bogus",
            RUNTIME_MODE: "local-safe",
          }),
        ),
      ).toBe("local-safe");
    });

    it("falls back to env when the source has no getSetting", () => {
      vi.stubEnv("ELIZA_RUNTIME_MODE", "cloud");
      expect(resolveRuntimeExecutionMode(null)).toBe("cloud");
      expect(resolveRuntimeExecutionMode({})).toBe("cloud");
    });

    it("prefers earlier env keys over later ones", () => {
      vi.stubEnv("ELIZA_RUNTIME_MODE", "local-safe");
      vi.stubEnv("RUNTIME_MODE", "cloud");
      vi.stubEnv("LOCAL_RUNTIME_MODE", "local-yolo");
      expect(resolveRuntimeExecutionMode(null)).toBe("local-safe");
    });

    it("skips invalid env values and uses the next valid env key", () => {
      vi.stubEnv("ELIZA_RUNTIME_MODE", "nope");
      vi.stubEnv("RUNTIME_MODE", "  ");
      vi.stubEnv("LOCAL_RUNTIME_MODE", "cloud");
      expect(resolveRuntimeExecutionMode(null)).toBe("cloud");
    });

    it("clamps local-yolo to local-safe on iOS, including the empty-queue default", () => {
      vi.stubEnv("ELIZA_PLATFORM", "ios");
      expect(resolveRuntimeExecutionMode(null)).toBe("local-safe");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-yolo" }),
        ),
      ).toBe("local-safe");
    });

    it("does not clamp cloud or local-safe on iOS", () => {
      vi.stubEnv("ELIZA_PLATFORM", "ios");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "cloud" }),
        ),
      ).toBe("cloud");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-safe" }),
        ),
      ).toBe("local-safe");
    });

    it("does not clamp local-yolo on Android", () => {
      vi.stubEnv("ELIZA_PLATFORM", "android");
      expect(
        resolveRuntimeExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-yolo" }),
        ),
      ).toBe("local-yolo");
    });
  });

  describe("resolveLocalExecutionMode", () => {
    it("keeps local-safe and collapses every other resolved mode to local-yolo", () => {
      expect(
        resolveLocalExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-safe" }),
        ),
      ).toBe("local-safe");
      expect(
        resolveLocalExecutionMode(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-yolo" }),
        ),
      ).toBe("local-yolo");
      expect(
        resolveLocalExecutionMode(sourceFrom({ ELIZA_RUNTIME_MODE: "cloud" })),
      ).toBe("local-yolo");
    });

    it("returns local-safe for the iOS-clamped empty queue", () => {
      vi.stubEnv("ELIZA_PLATFORM", "ios");
      expect(resolveLocalExecutionMode(null)).toBe("local-safe");
    });
  });

  describe("shouldUseSandboxExecution", () => {
    it("is true only when the resolved runtime mode is local-safe", () => {
      expect(
        shouldUseSandboxExecution(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-safe" }),
        ),
      ).toBe(true);
      expect(
        shouldUseSandboxExecution(
          sourceFrom({ ELIZA_RUNTIME_MODE: "local-yolo" }),
        ),
      ).toBe(false);
      expect(
        shouldUseSandboxExecution(sourceFrom({ ELIZA_RUNTIME_MODE: "cloud" })),
      ).toBe(false);
      expect(shouldUseSandboxExecution(null)).toBe(false);
    });

    it("becomes true on iOS because local-yolo is clamped", () => {
      vi.stubEnv("ELIZA_PLATFORM", "ios");
      expect(shouldUseSandboxExecution(null)).toBe(true);
    });
  });

  describe("isCloudExecutionMode", () => {
    it("is true only for the cloud runtime mode", () => {
      expect(
        isCloudExecutionMode(sourceFrom({ ELIZA_RUNTIME_MODE: "cloud" })),
      ).toBe(true);
      expect(
        isCloudExecutionMode(sourceFrom({ ELIZA_RUNTIME_MODE: "local-safe" })),
      ).toBe(false);
      expect(
        isCloudExecutionMode(sourceFrom({ ELIZA_RUNTIME_MODE: "local-yolo" })),
      ).toBe(false);
      expect(isCloudExecutionMode(null)).toBe(false);
    });

    it("stays true for cloud on iOS", () => {
      vi.stubEnv("ELIZA_PLATFORM", "ios");
      expect(
        isCloudExecutionMode(sourceFrom({ ELIZA_RUNTIME_MODE: "cloud" })),
      ).toBe(true);
    });
  });
});
