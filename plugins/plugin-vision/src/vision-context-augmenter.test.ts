/**
 * Vision context augmenter tests for OCR, object, and face prompt enrichment.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  OcrWithCoordsResult,
  OcrWithCoordsService,
} from "./ocr-with-coords.js";
import {
  buildAugmentedPrompt,
  FusedVisionContextAugmenter,
  isMeaningfulOcrText,
} from "./vision-context-augmenter.js";

/** A coord-OCR service that returns fixed blocks — no tesseract binary. */
function fakeOcr(blocks: Array<{ text: string }>): OcrWithCoordsService {
  return {
    name: "fake-ocr",
    async describe(): Promise<OcrWithCoordsResult> {
      return {
        blocks: blocks.map((b) => ({
          text: b.text,
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          words: [],
          semantic_position: "center" as const,
        })),
      };
    },
  };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const IMAGE = { kind: "bytes" as const, bytes: PNG_BYTES };

describe("buildAugmentedPrompt", () => {
  it("appends a delimited detected-context block with all three signals", () => {
    const out = buildAugmentedPrompt("What is this?", {
      ocrText: '"ELIZA OCR TEST 1234"',
      objects: "person (0.94), laptop (0.81)",
      faces: "2 faces",
    });
    expect(out).toContain("What is this?");
    expect(out).toContain("Detected context");
    expect(out).toContain('- Text (OCR): "ELIZA OCR TEST 1234"');
    expect(out).toContain("- Objects: person (0.94), laptop (0.81)");
    expect(out).toContain("- Faces: 2 faces");
  });

  it("falls back to the default describe prompt when no base is given", () => {
    const out = buildAugmentedPrompt(undefined, { ocrText: '"hi"' });
    expect(out.startsWith("Describe what is in this image.")).toBe(true);
  });

  it("returns the bare base prompt when there are no signals", () => {
    expect(buildAugmentedPrompt("base", {})).toBe("base");
  });
});

describe("isMeaningfulOcrText", () => {
  it("keeps real words/labels and drops photo-OCR noise", () => {
    for (const good of ["Bus", "RID", "10", "STOP", "Avani"]) {
      expect(isMeaningfulOcrText(good)).toBe(true);
    }
    for (const noise of ["|", "—", "=", ":", "a", "\\", "‘"]) {
      expect(isMeaningfulOcrText(noise)).toBe(false);
    }
  });
});

describe("FusedVisionContextAugmenter", () => {
  it("drops noisy single-glyph OCR fragments, keeps real text", async () => {
    const aug = new FusedVisionContextAugmenter({
      getOcr: () =>
        fakeOcr([
          { text: "|" },
          { text: "Bus" },
          { text: "—" },
          { text: "RID" },
          { text: "a" },
        ]),
    });
    const out = await aug.augmentImagePrompt({ image: IMAGE });
    expect(out?.fused.ocrText).toBe('"Bus", "RID"');
  });

  it("fuses OCR text into the prompt", async () => {
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => fakeOcr([{ text: "ELIZA OCR TEST 1234" }]),
    });
    const out = await aug.augmentImagePrompt({
      image: IMAGE,
      basePrompt: "Describe the image.",
    });
    expect(out).not.toBeNull();
    expect(out?.fused.ocrText).toBe('"ELIZA OCR TEST 1234"');
    expect(out?.prompt).toContain("ELIZA OCR TEST 1234");
    expect(out?.prompt).toContain("Describe the image.");
  });

  it("fuses OCR + objects + faces from all detectors", async () => {
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => fakeOcr([{ text: "SALE 50% OFF" }]),
      detectObjects: async () => [
        { type: "person", confidence: 0.94 },
        { type: "handbag", confidence: 0.7 },
      ],
      detectFaces: async () => 1,
    });
    const out = await aug.augmentImagePrompt({ image: IMAGE });
    expect(out?.fused.ocrText).toBe('"SALE 50% OFF"');
    expect(out?.fused.objects).toBe("person (0.94), handbag (0.70)");
    expect(out?.fused.faces).toBe("1 face");
    expect(out?.prompt).toContain("- Objects: person (0.94), handbag (0.70)");
    expect(out?.prompt).toContain("- Faces: 1 face");
  });

  it("returns null when no detector produces a signal (so the prompt is left unchanged)", async () => {
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => fakeOcr([]),
      detectObjects: async () => [],
      detectFaces: async () => 0,
    });
    expect(await aug.augmentImagePrompt({ image: IMAGE })).toBeNull();
  });

  it("degrades gracefully when a detector throws (OCR still fuses)", async () => {
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => fakeOcr([{ text: "STILL WORKS" }]),
      detectObjects: async () => {
        throw new Error("yolo native lib missing");
      },
      detectFaces: async () => {
        throw new Error("blazeface weights missing");
      },
    });
    const out = await aug.augmentImagePrompt({ image: IMAGE });
    expect(out?.fused.ocrText).toBe('"STILL WORKS"');
    expect(out?.fused.objects).toBeUndefined();
    expect(out?.fused.faces).toBeUndefined();
  });

  it("is idempotent — skips a prompt that already carries a fused-context block", async () => {
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => fakeOcr([{ text: "AGAIN" }]),
    });
    const once = await aug.augmentImagePrompt({
      image: IMAGE,
      basePrompt: "Describe.",
    });
    // Feeding the already-augmented prompt back in must not stack a 2nd block.
    const twice = await aug.augmentImagePrompt({
      image: IMAGE,
      basePrompt: once?.prompt,
    });
    expect(twice).toBeNull();
  });

  it("decodes a data-URL image input", async () => {
    const b64 = Buffer.from(PNG_BYTES).toString("base64");
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => fakeOcr([{ text: "FROM DATAURL" }]),
    });
    const out = await aug.augmentImagePrompt({
      image: { kind: "dataUrl", dataUrl: `data:image/png;base64,${b64}` },
    });
    expect(out?.fused.ocrText).toBe('"FROM DATAURL"');
  });

  // Security regression: the augmenter must NOT read local files for `url`
  // inputs. A readFileSync on an agent-supplied file:///bare-path describe URL
  // is a local-file-read primitive — the augmenter performs no file I/O and
  // returns no augmentation for any url shape (the backend resolves the image).
  it("never reads local files for url inputs (no local-file-read primitive)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vca-sec-"));
    const onDisk = join(dir, "real.png");
    writeFileSync(onDisk, Buffer.from(PNG_BYTES));
    let ocrRan = false;
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => ({
        name: "spy-ocr",
        async describe(): Promise<OcrWithCoordsResult> {
          ocrRan = true;
          return {
            blocks: [
              {
                text: "LEAKED FILE CONTENTS",
                bbox: { x: 0, y: 0, width: 10, height: 10 },
                words: [],
                semantic_position: "center" as const,
              },
            ],
          };
        },
      }),
    });
    // A real readable file at each url shape: the fixed augmenter still must not
    // touch it (OCR never runs → result null), so file:// and bare paths can't
    // be used to exfiltrate disk contents into the describe prompt.
    for (const url of [
      `file://${onDisk}`,
      onDisk,
      "https://example.com/x.png",
    ]) {
      expect(
        await aug.augmentImagePrompt({ image: { kind: "url", url } }),
      ).toBeNull();
    }
    expect(ocrRan).toBe(false);
  });
});
