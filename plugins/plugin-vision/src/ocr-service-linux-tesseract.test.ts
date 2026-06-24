/**
 * Tests for the native Linux tesseract coord provider (M4, #9105).
 *
 * The pure mapper runs on every platform from an injected TSV fixture — CI
 * never needs a real tesseract binary installed. The availability probe is
 * platform-gated; the real end-to-end OCR test only makes sense on a Linux
 * host with `tesseract-ocr` present, so we don't exercise it here.
 */

import { describe, expect, it } from "vitest";
import {
  LinuxTesseractOcrService,
  mapTesseractTsvToResult,
  parseTesseractTsv,
} from "./ocr-service-linux-tesseract.js";

// A realistic `tesseract <img> stdout --psm 11 tsv` fixture. Columns:
// level page block par line word left top width height conf text
// Two words on one line ("Save File", block/par/line 1/1/1), then one word on
// a second line ("Cancel", block/par/line 1/1/2). Plus the structural
// page/block/para/line rows (levels 1-4) and a header — all of which the
// parser must skip.
const SAMPLE_TSV = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "1\t1\t0\t0\t0\t0\t0\t0\t200\t60\t-1\t",
  "2\t1\t1\t0\t0\t0\t10\t20\t86\t40\t-1\t",
  "3\t1\t1\t1\t0\t0\t10\t20\t86\t40\t-1\t",
  "4\t1\t1\t1\t1\t0\t10\t20\t86\t16\t-1\t",
  "5\t1\t1\t1\t1\t1\t10\t20\t40\t16\t96.5\tSave",
  "5\t1\t1\t1\t1\t2\t60\t20\t36\t16\t95.1\tFile",
  "4\t1\t1\t1\t2\t0\t10\t44\t52\t16\t-1\t",
  "5\t1\t1\t1\t2\t1\t10\t44\t52\t16\t90.0\tCancel",
].join("\n");

describe("parseTesseractTsv (pure)", () => {
  it("keeps only level-5 word rows with non-blank text", () => {
    const rows = parseTesseractTsv(SAMPLE_TSV);
    expect(rows.map((r) => r.text)).toEqual(["Save", "File", "Cancel"]);
    expect(rows[0]).toMatchObject({
      blockNum: 1,
      parNum: 1,
      lineNum: 1,
      left: 10,
      top: 20,
      width: 40,
      height: 16,
      conf: 96.5,
      text: "Save",
    });
  });

  it("ignores the header, empty lines, and short/malformed rows", () => {
    const noisy = ["", "garbage", "5\t1\t1", SAMPLE_TSV, ""].join("\n");
    expect(parseTesseractTsv(noisy).map((r) => r.text)).toEqual([
      "Save",
      "File",
      "Cancel",
    ]);
  });
});

describe("mapTesseractTsvToResult (pure)", () => {
  it("groups words by block/par/line into blocks with union bbox + source shift", () => {
    const result = mapTesseractTsvToResult(SAMPLE_TSV, 200, 60, 100, 200);
    expect(result.blocks).toHaveLength(2);

    const [first, second] = result.blocks;
    // Line 1: "Save File", union of word rects (10..96 x, 20..36 y), shifted
    // by source (100, 200).
    expect(first.text).toBe("Save File");
    expect(first.bbox).toEqual({ x: 110, y: 220, width: 86, height: 16 });
    expect(first.words.map((w) => w.text)).toEqual(["Save", "File"]);
    expect(first.words[0].bbox).toEqual({
      x: 110,
      y: 220,
      width: 40,
      height: 16,
    });
    expect(first.words[1].bbox).toEqual({
      x: 160,
      y: 220,
      width: 36,
      height: 16,
    });
    expect(first.semantic_position).toBeDefined();

    // Line 2: "Cancel".
    expect(second.text).toBe("Cancel");
    expect(second.bbox).toEqual({ x: 110, y: 244, width: 52, height: 16 });
    expect(second.words).toHaveLength(1);
  });

  it("returns no blocks for an empty / header-only TSV", () => {
    const headerOnly =
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    expect(mapTesseractTsvToResult(headerOnly, 100, 100, 0, 0).blocks).toEqual(
      [],
    );
    expect(mapTesseractTsvToResult("", 100, 100, 0, 0).blocks).toEqual([]);
  });

  it("tolerates zero tile dimensions without throwing", () => {
    const result = mapTesseractTsvToResult(SAMPLE_TSV, 0, 0, 0, 0);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].semantic_position).toBeDefined();
  });
});

describe("LinuxTesseractOcrService", () => {
  it("returns empty blocks for empty input (no spawn)", async () => {
    const svc = new LinuxTesseractOcrService();
    const r = await svc.describe({
      displayId: "0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: new Uint8Array(0),
    });
    expect(r).toEqual({ blocks: [] });
  });

  it("reports unavailable off Linux without requiring a binary", () => {
    if (process.platform !== "linux") {
      expect(LinuxTesseractOcrService.isAvailable()).toBe(false);
    } else {
      // On Linux the result depends on whether tesseract is installed; either
      // way the probe must return a boolean and never throw.
      expect(typeof LinuxTesseractOcrService.isAvailable()).toBe("boolean");
    }
  });
});
