/**
 * Tests for usePlatform Hook — Platform Detection Priority
 *
 * Tests the platform detection priority logic as a pure function,
 * replicating the hook's decision tree without React context dependencies.
 *
 * Priority order (first match wins):
 *   1. Farcaster (most specific detection)
 *   2. Telegram (deterministic isTMA check)
 *   3. Discord (iframe + query-param heuristic)
 *   4. Web (fallback)
 */

import { describe, expect, it } from "bun:test";

type Platform = "farcaster" | "telegram" | "discord" | "web";

interface ProviderState {
  farcaster: { isMiniApp: boolean; isLoading: boolean };
  telegram: { isMiniApp: boolean; isLoading: boolean };
  discord: { isActivity: boolean; isLoading: boolean };
}

/**
 * Pure function replicating usePlatform's detection logic.
 * This mirrors the hook implementation exactly.
 */
function detectPlatform(state: ProviderState): {
  platform: Platform;
  isLoading: boolean;
} {
  const isLoading =
    state.farcaster.isLoading ||
    state.telegram.isLoading ||
    state.discord.isLoading;

  if (state.farcaster.isMiniApp) return { platform: "farcaster", isLoading };
  if (state.telegram.isMiniApp) return { platform: "telegram", isLoading };
  if (state.discord.isActivity) return { platform: "discord", isLoading };

  return { platform: "web", isLoading };
}

describe("usePlatform — Platform Detection", () => {
  describe("Single platform active", () => {
    it("should detect Farcaster when isMiniApp is true", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: true, isLoading: false },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.platform).toBe("farcaster");
      expect(result.isLoading).toBe(false);
    });

    it("should detect Telegram when isMiniApp is true", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: true, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.platform).toBe("telegram");
      expect(result.isLoading).toBe(false);
    });

    it("should detect Discord when isActivity is true", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: true, isLoading: false },
      });
      expect(result.platform).toBe("discord");
      expect(result.isLoading).toBe(false);
    });

    it("should fall back to web when no platform is active", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.platform).toBe("web");
      expect(result.isLoading).toBe(false);
    });
  });

  describe("Priority ordering (multiple platforms active)", () => {
    it("should prefer Farcaster over Telegram", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: true, isLoading: false },
        telegram: { isMiniApp: true, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.platform).toBe("farcaster");
    });

    it("should prefer Farcaster over Discord", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: true, isLoading: false },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: true, isLoading: false },
      });
      expect(result.platform).toBe("farcaster");
    });

    it("should prefer Telegram over Discord", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: true, isLoading: false },
        discord: { isActivity: true, isLoading: false },
      });
      expect(result.platform).toBe("telegram");
    });

    it("should prefer Farcaster when all platforms are active", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: true, isLoading: false },
        telegram: { isMiniApp: true, isLoading: false },
        discord: { isActivity: true, isLoading: false },
      });
      expect(result.platform).toBe("farcaster");
    });
  });

  describe("Loading states", () => {
    it("should report isLoading=true when any provider is loading", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: true },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.isLoading).toBe(true);
    });

    it("should report isLoading=true when Telegram is loading", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: false, isLoading: true },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.isLoading).toBe(true);
    });

    it("should report isLoading=true when Discord is loading", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: false, isLoading: true },
      });
      expect(result.isLoading).toBe(true);
    });

    it("should report isLoading=true when all providers are loading", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: true },
        telegram: { isMiniApp: false, isLoading: true },
        discord: { isActivity: false, isLoading: true },
      });
      expect(result.isLoading).toBe(true);
    });

    it("should report isLoading=false when no providers are loading", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: false },
        telegram: { isMiniApp: false, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.isLoading).toBe(false);
    });

    it("should still detect platform correctly while loading", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: false, isLoading: true },
        telegram: { isMiniApp: true, isLoading: false },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.platform).toBe("telegram");
      expect(result.isLoading).toBe(true);
    });

    it("should propagate loading state with detected platform", () => {
      const result = detectPlatform({
        farcaster: { isMiniApp: true, isLoading: false },
        telegram: { isMiniApp: false, isLoading: true },
        discord: { isActivity: false, isLoading: false },
      });
      expect(result.platform).toBe("farcaster");
      expect(result.isLoading).toBe(true);
    });
  });
});
