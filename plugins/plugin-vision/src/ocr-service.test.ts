import { describe, expect, it } from "vitest";
import { OCRService } from "./ocr-service";
import { DoctrOCRService, shouldPreferAppleVision } from "./ocr-service-doctr";

describe("DoctrOCRService availability", () => {
  it("reports availability via a typed boolean", async () => {
    const result = await DoctrOCRService.isAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("initialize() throws cleanly when GGUF weights are not present", async () => {
    // Pin nonexistent paths so the readiness check fails immediately. The
    // error must be clearly attributable to missing GGUFs (no silent
    // fallback).
    const doctr = new DoctrOCRService({
      detPath: `/tmp/doctr-det-missing-${Date.now()}.gguf`,
      recPath: `/tmp/doctr-rec-missing-${Date.now()}.gguf`,
    });
    await expect(doctr.initialize()).rejects.toBeInstanceOf(Error);
  });
});

describe("OCRService backend chain", () => {
  it("respects forced backend selection (no init)", () => {
    expect(new OCRService({ backend: "doctr" })).toBeInstanceOf(OCRService);
    expect(new OCRService({ backend: "apple-vision" })).toBeInstanceOf(
      OCRService,
    );
  });

  it("getActiveBackend returns null before initialize()", () => {
    const svc = new OCRService();
    expect(svc.getActiveBackend()).toBeNull();
    expect(svc.isInitialized()).toBe(false);
  });

  it("allows ELIZA_DISABLE_APPLE_VISION to disable apple-vision tier", () => {
    const original = process.env.ELIZA_DISABLE_APPLE_VISION;
    process.env.ELIZA_DISABLE_APPLE_VISION = "1";
    try {
      expect(shouldPreferAppleVision()).toBe(false);
    } finally {
      if (original === undefined) delete process.env.ELIZA_DISABLE_APPLE_VISION;
      else process.env.ELIZA_DISABLE_APPLE_VISION = original;
    }
  });

  it("apple-vision is the chosen tier only on darwin", () => {
    if (process.platform === "darwin") {
      const original = process.env.ELIZA_DISABLE_APPLE_VISION;
      delete process.env.ELIZA_DISABLE_APPLE_VISION;
      try {
        expect(shouldPreferAppleVision()).toBe(true);
      } finally {
        if (original !== undefined)
          process.env.ELIZA_DISABLE_APPLE_VISION = original;
      }
    } else {
      expect(shouldPreferAppleVision()).toBe(false);
    }
  });
});
