/**
 * Tests for @milaidy/capacitor-talkmode plugin
 *
 * Verifies:
 * - Module exports (TalkModeWeb class + definition types)
 * - TalkModeWeb class instantiation and method signatures
 * - State management (idle by default)
 * - Speaking state
 * - Listener registration and cleanup
 */
import { describe, it, expect, beforeEach } from "vitest";

describe("@milaidy/capacitor-talkmode", () => {
  let talkmode: InstanceType<Awaited<typeof import("../../plugins/talkmode/src/web")>["TalkModeWeb"]>;

  beforeEach(async () => {
    const { TalkModeWeb } = await import("../../plugins/talkmode/src/web");
    talkmode = new TalkModeWeb();
  });

  describe("module exports", () => {
    it("exports TalkModeWeb class", async () => {
      const mod = await import("../../plugins/talkmode/src/web");
      expect(mod.TalkModeWeb).toBeDefined();
      expect(typeof mod.TalkModeWeb).toBe("function");
    });
  });

  describe("method signatures", () => {
    it("has all required plugin methods", () => {
      expect(typeof talkmode.start).toBe("function");
      expect(typeof talkmode.stop).toBe("function");
      expect(typeof talkmode.isEnabled).toBe("function");
      expect(typeof talkmode.getState).toBe("function");
      expect(typeof talkmode.updateConfig).toBe("function");
      expect(typeof talkmode.speak).toBe("function");
      expect(typeof talkmode.stopSpeaking).toBe("function");
      expect(typeof talkmode.isSpeaking).toBe("function");
      expect(typeof talkmode.checkPermissions).toBe("function");
      expect(typeof talkmode.requestPermissions).toBe("function");
      expect(typeof talkmode.addListener).toBe("function");
      expect(typeof talkmode.removeAllListeners).toBe("function");
    });
  });

  describe("state management", () => {
    it("reports not enabled by default", async () => {
      const result = await talkmode.isEnabled();
      expect(result.enabled).toBe(false);
    });

    it("reports idle state by default", async () => {
      const result = await talkmode.getState();
      expect(result.state).toBe("idle");
      expect(typeof result.statusText).toBe("string");
    });

    it("reports not speaking by default", async () => {
      const result = await talkmode.isSpeaking();
      expect(result.speaking).toBe(false);
    });
  });

  describe("stop when not started", () => {
    it("stop completes without error when not enabled", async () => {
      await expect(talkmode.stop()).resolves.toBeUndefined();
    });

    it("stopSpeaking completes when not speaking", async () => {
      const result = await talkmode.stopSpeaking();
      expect(result).toBeDefined();
    });
  });

  describe("definition types", () => {
    it("definitions module loads without error", async () => {
      const mod = await import("../../plugins/talkmode/src/definitions");
      expect(mod).toBeDefined();
    });
  });
});
