/**
 * WS10 golden path: screen-capture → OCR → grounding → click coordinate.
 *
 * This test validates PLUMBING, not pixels. Every model-bearing component
 * (screen capture, OCR, VLM grounding) is replaced with a deterministic
 * stub that emits a fixed result for a known fixture. The assertion is
 * that the orchestrated golden path produces a click coordinate inside
 * the OCR-detected bbox.
 *
 * When WS2 (vision arbiter) / WS8 (OCR + grounding) finish landing, the
 * stub contracts here become the integration contract — swap the stub
 * for the real `IModelArbiter` and re-run.
 */

import { describe, expect, it } from "vitest";

/* --------------------------------------------------------------------- */
/* Stub contracts (these mirror the WS2/WS8 expected interfaces).         */
/* --------------------------------------------------------------------- */

interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OcrHit {
  text: string;
  bbox: BBox;
  confidence: number;
}

interface CapturedScreen {
  png: Buffer;
  width: number;
  height: number;
}

interface ClickGroundingRequest {
  target: string;
  screen: CapturedScreen;
  ocr: OcrHit[];
}

interface ClickGroundingResult {
  hit: OcrHit;
  click: { x: number; y: number };
  confidence: number;
}

/* --------------------------------------------------------------------- */
/* Deterministic stubs                                                    */
/* --------------------------------------------------------------------- */

// A 1-pixel PNG is enough to validate "this is a real PNG buffer". Real
// fixture bytes (the 8-byte signature + IHDR + IDAT + IEND).
const ONE_PX_PNG: Buffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54,
  0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05,
  0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function stubCaptureScreen(): CapturedScreen {
  return { png: ONE_PX_PNG, width: 1920, height: 1080 };
}

function stubOcr(_screen: CapturedScreen): OcrHit[] {
  // Two fixture hits: a "Save" button at (1700, 1000, 80, 32) and a
  // "Cancel" button at (1600, 1000, 80, 32). The grounding stub uses
  // exact text match to pick the right hit.
  return [
    {
      text: "Save",
      bbox: { x: 1700, y: 1000, w: 80, h: 32 },
      confidence: 0.97,
    },
    {
      text: "Cancel",
      bbox: { x: 1600, y: 1000, w: 80, h: 32 },
      confidence: 0.95,
    },
  ];
}

function stubGround(req: ClickGroundingRequest): ClickGroundingResult {
  const hit = req.ocr.find((h) =>
    h.text.toLowerCase() === req.target.toLowerCase(),
  );
  if (!hit) throw new Error(`stub-ground: no OCR hit for target "${req.target}"`);
  return {
    hit,
    click: {
      x: Math.round(hit.bbox.x + hit.bbox.w / 2),
      y: Math.round(hit.bbox.y + hit.bbox.h / 2),
    },
    confidence: hit.confidence,
  };
}

/* --------------------------------------------------------------------- */
/* Test                                                                   */
/* --------------------------------------------------------------------- */

describe("golden path: screen → OCR → click grounding", () => {
  it("captures a PNG, OCRs it, and returns a click inside the matched bbox", () => {
    const screen = stubCaptureScreen();
    expect(screen.png[0]).toBe(0x89); // PNG signature byte 0
    expect(screen.png[1]).toBe(0x50);
    expect(screen.png[2]).toBe(0x4e);
    expect(screen.png[3]).toBe(0x47);
    expect(screen.width).toBeGreaterThan(0);
    expect(screen.height).toBeGreaterThan(0);

    const ocr = stubOcr(screen);
    expect(ocr.length).toBeGreaterThan(0);
    for (const h of ocr) {
      expect(typeof h.text).toBe("string");
      expect(h.bbox.w).toBeGreaterThan(0);
      expect(h.bbox.h).toBeGreaterThan(0);
    }

    const grounded = stubGround({ target: "Save", screen, ocr });
    expect(grounded.hit.text).toBe("Save");
    // Click point lies strictly inside the bbox.
    expect(grounded.click.x).toBeGreaterThanOrEqual(grounded.hit.bbox.x);
    expect(grounded.click.x).toBeLessThanOrEqual(
      grounded.hit.bbox.x + grounded.hit.bbox.w,
    );
    expect(grounded.click.y).toBeGreaterThanOrEqual(grounded.hit.bbox.y);
    expect(grounded.click.y).toBeLessThanOrEqual(
      grounded.hit.bbox.y + grounded.hit.bbox.h,
    );
    expect(grounded.confidence).toBeGreaterThan(0.5);
  });

  it("surfaces a deterministic failure when the target text is absent", () => {
    const screen = stubCaptureScreen();
    const ocr = stubOcr(screen);
    expect(() => stubGround({ target: "DoesNotExist", screen, ocr })).toThrow(
      /no OCR hit/,
    );
  });
});
