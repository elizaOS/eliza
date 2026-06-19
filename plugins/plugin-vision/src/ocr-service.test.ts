import { describe, expect, it } from "vitest";
import { extractStructuredDataFromOCR, OCRService } from "./ocr-service";
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

describe("extractStructuredDataFromOCR", () => {
  it("extracts forms, lists, and delimited tables from OCR blocks", () => {
    const structured = extractStructuredDataFromOCR({
      text: "",
      fullText: "",
      blocks: [
        {
          text: "Name: Ada\nEmail: ada@example.com",
          bbox: { x: 0, y: 0, width: 100, height: 30 },
          confidence: 0.99,
        },
        {
          text: "- Alpha\n- Beta",
          bbox: { x: 0, y: 40, width: 100, height: 30 },
          confidence: 0.99,
        },
        {
          text: "Symbol | Price\nSOL | 150",
          bbox: { x: 0, y: 80, width: 100, height: 30 },
          confidence: 0.99,
        },
      ],
    });

    expect(structured.forms).toEqual([
      {
        label: "Name",
        value: "Ada",
        bbox: { x: 0, y: 0, width: 100, height: 30 },
      },
      {
        label: "Email",
        value: "ada@example.com",
        bbox: { x: 0, y: 0, width: 100, height: 30 },
      },
    ]);
    expect(structured.lists).toEqual([
      {
        items: ["Alpha", "Beta"],
        bbox: { x: 0, y: 40, width: 100, height: 30 },
      },
    ]);
    expect(structured.tables).toContainEqual({
      rows: [
        ["Symbol", "Price"],
        ["SOL", "150"],
      ],
      bbox: { x: 0, y: 80, width: 100, height: 30 },
    });
  });

  it("extracts simple table rows from word coordinates", () => {
    const structured = extractStructuredDataFromOCR({
      text: "",
      fullText: "",
      blocks: [
        {
          text: "Name Age Ada 37",
          bbox: { x: 0, y: 0, width: 100, height: 40 },
          confidence: 0.99,
          words: [
            {
              text: "Name",
              bbox: { x: 0, y: 0, width: 20, height: 10 },
              confidence: 0.99,
            },
            {
              text: "Age",
              bbox: { x: 50, y: 0, width: 20, height: 10 },
              confidence: 0.99,
            },
            {
              text: "Ada",
              bbox: { x: 0, y: 20, width: 20, height: 10 },
              confidence: 0.99,
            },
            {
              text: "37",
              bbox: { x: 50, y: 20, width: 20, height: 10 },
              confidence: 0.99,
            },
          ],
        },
      ],
    });

    expect(structured.tables).toContainEqual({
      rows: [
        ["Name", "Age"],
        ["Ada", "37"],
      ],
      bbox: { x: 0, y: 0, width: 70, height: 30 },
    });
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
