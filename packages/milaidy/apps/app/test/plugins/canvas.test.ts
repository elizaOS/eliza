/**
 * Tests for @milaidy/capacitor-canvas plugin
 *
 * Verifies:
 * - Module exports (CanvasWeb class + definition types)
 * - CanvasWeb class instantiation and method signatures
 * - All drawing, layer, and web view methods exist
 */
import { describe, it, expect, beforeEach } from "vitest";

// The canvas web implementation is large; test that the module structure is correct
describe("@milaidy/capacitor-canvas", () => {
  it("exports CanvasWeb class from web module", async () => {
    const mod = await import("../../plugins/canvas/src/web");
    expect(mod.CanvasWeb).toBeDefined();
    expect(typeof mod.CanvasWeb).toBe("function");
  });

  it("exports definitions from definitions module", async () => {
    // Definitions are types only, so we verify the module loads without error
    const mod = await import("../../plugins/canvas/src/definitions");
    expect(mod).toBeDefined();
  });

  describe("CanvasWeb instance", () => {
    let canvas: InstanceType<Awaited<typeof import("../../plugins/canvas/src/web")>["CanvasWeb"]>;

    beforeEach(async () => {
      const { CanvasWeb } = await import("../../plugins/canvas/src/web");
      canvas = new CanvasWeb();
    });

    it("has all canvas management methods", () => {
      expect(typeof canvas.create).toBe("function");
      expect(typeof canvas.destroy).toBe("function");
      expect(typeof canvas.attach).toBe("function");
      expect(typeof canvas.detach).toBe("function");
      expect(typeof canvas.resize).toBe("function");
      expect(typeof canvas.clear).toBe("function");
    });

    it("has all layer management methods", () => {
      expect(typeof canvas.createLayer).toBe("function");
      expect(typeof canvas.updateLayer).toBe("function");
      expect(typeof canvas.deleteLayer).toBe("function");
      expect(typeof canvas.getLayers).toBe("function");
    });

    it("has all drawing methods", () => {
      expect(typeof canvas.drawRect).toBe("function");
      expect(typeof canvas.drawEllipse).toBe("function");
      expect(typeof canvas.drawLine).toBe("function");
      expect(typeof canvas.drawPath).toBe("function");
      expect(typeof canvas.drawText).toBe("function");
      expect(typeof canvas.drawImage).toBe("function");
      expect(typeof canvas.drawBatch).toBe("function");
    });

    it("has pixel and export methods", () => {
      expect(typeof canvas.getPixelData).toBe("function");
      expect(typeof canvas.toImage).toBe("function");
    });

    it("has transform methods", () => {
      expect(typeof canvas.setTransform).toBe("function");
      expect(typeof canvas.resetTransform).toBe("function");
    });

    it("has web view methods", () => {
      expect(typeof canvas.navigate).toBe("function");
      expect(typeof canvas.eval).toBe("function");
      expect(typeof canvas.snapshot).toBe("function");
      expect(typeof canvas.a2uiPush).toBe("function");
      expect(typeof canvas.a2uiReset).toBe("function");
    });

    it("has touch and event methods", () => {
      expect(typeof canvas.setTouchEnabled).toBe("function");
      expect(typeof canvas.addListener).toBe("function");
      expect(typeof canvas.removeAllListeners).toBe("function");
    });
  });
});
