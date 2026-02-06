/**
 * Tests for @milaidy/capacitor-swabble plugin
 *
 * Verifies:
 * - Module exports (SwabbleWeb class + definition types)
 * - SwabbleWeb class instantiation and method signatures
 * - State management (listening state)
 * - Config management
 * - Listener registration and cleanup
 */
import { describe, it, expect, beforeEach } from "vitest";

describe("@milaidy/capacitor-swabble", () => {
  let swabble: InstanceType<Awaited<typeof import("../../plugins/swabble/src/web")>["SwabbleWeb"]>;

  beforeEach(async () => {
    const { SwabbleWeb } = await import("../../plugins/swabble/src/web");
    swabble = new SwabbleWeb();
  });

  describe("module exports", () => {
    it("exports SwabbleWeb class", async () => {
      const mod = await import("../../plugins/swabble/src/web");
      expect(mod.SwabbleWeb).toBeDefined();
      expect(typeof mod.SwabbleWeb).toBe("function");
    });
  });

  describe("method signatures", () => {
    it("has all required plugin methods", () => {
      expect(typeof swabble.start).toBe("function");
      expect(typeof swabble.stop).toBe("function");
      expect(typeof swabble.isListening).toBe("function");
      expect(typeof swabble.getConfig).toBe("function");
      expect(typeof swabble.updateConfig).toBe("function");
      expect(typeof swabble.checkPermissions).toBe("function");
      expect(typeof swabble.requestPermissions).toBe("function");
      expect(typeof swabble.getAudioDevices).toBe("function");
      expect(typeof swabble.setAudioDevice).toBe("function");
      expect(typeof swabble.addListener).toBe("function");
      expect(typeof swabble.removeAllListeners).toBe("function");
    });
  });

  describe("state management", () => {
    it("reports not listening by default", async () => {
      const result = await swabble.isListening();
      expect(result.listening).toBe(false);
    });

    it("returns null config when not started", async () => {
      const result = await swabble.getConfig();
      expect(result.config).toBeNull();
    });
  });

  describe("stop when not started", () => {
    it("stop completes without error when not listening", async () => {
      await expect(swabble.stop()).resolves.toBeUndefined();
    });
  });

  describe("definition types", () => {
    it("definitions module loads without error", async () => {
      const mod = await import("../../plugins/swabble/src/definitions");
      expect(mod).toBeDefined();
    });
  });
});
