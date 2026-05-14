import { describe, expect, it, vi } from "vitest";
import { OCRService } from "./ocr-service";
import { RapidOCRService } from "./ocr-service-rapid";

describe("RapidOCRService availability", () => {
  it("reports availability via a typed boolean", async () => {
    const result = await RapidOCRService.isAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("initialize() throws cleanly when models cannot be fetched", async () => {
    // We pin a fake URL so the fetch fails fast and we exercise the failure
    // path without touching the real RapidAI mirror.
    const rapid = new RapidOCRService({
      modelDir: `/tmp/rapidocr-test-${Date.now()}`,
      bundle: {
        detection: { url: "http://127.0.0.1:1/det.onnx", sha256: null },
        recognition: { url: "http://127.0.0.1:1/rec.onnx", sha256: null },
        charset: { url: "http://127.0.0.1:1/charset.txt", sha256: null },
      },
    });
    await expect(rapid.initialize()).rejects.toBeInstanceOf(Error);
  });
});

describe("OCRService backend chain", () => {
  it("respects forced backend selection (no init)", () => {
    expect(new OCRService({ backend: "rapid" })).toBeInstanceOf(OCRService);
    expect(new OCRService({ backend: "tesseract" })).toBeInstanceOf(OCRService);
  });

  it("getActiveBackend returns null before initialize()", () => {
    const svc = new OCRService();
    expect(svc.getActiveBackend()).toBeNull();
    expect(svc.isInitialized()).toBe(false);
  });

  it("allows ELIZA_DISABLE_APPLE_VISION to disable apple-vision tier", async () => {
    const original = process.env.ELIZA_DISABLE_APPLE_VISION;
    process.env.ELIZA_DISABLE_APPLE_VISION = "1";
    try {
      const { shouldPreferAppleVision } = await import("./ocr-service-rapid");
      expect(shouldPreferAppleVision()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ELIZA_DISABLE_APPLE_VISION;
      else process.env.ELIZA_DISABLE_APPLE_VISION = original;
    }
  });

  it("apple-vision is the chosen tier only on darwin", async () => {
    const { shouldPreferAppleVision } = await import("./ocr-service-rapid");
    if (process.platform === "darwin") {
      expect(shouldPreferAppleVision()).toBe(true);
    } else {
      expect(shouldPreferAppleVision()).toBe(false);
    }
  });
});
