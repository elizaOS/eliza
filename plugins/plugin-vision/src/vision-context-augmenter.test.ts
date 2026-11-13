/**
 * Vision context augmenter tests for OCR, object, and face prompt enrichment.
 * The model-case block replays the scenarios that quint/VisionDescribeOcr.qnt
 * generates (check-vision-describe-ocr.mjs).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type OcrWithCoordsResult,
  type OcrWithCoordsService,
  RapidOcrCoordAdapter,
  readPngDimensionsOrNull,
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

/** A real 1x1 PNG: a PNG input reaches the OCR service unchanged. */
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
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

  it("OCRs a JPEG input through the PNG-only coord adapter", async () => {
    // RapidOcrCoordAdapter is the coord-OCR service on macOS and wherever no
    // tesseract, Windows or PaddleOCR engine is found. It reads the tile size
    // from the PNG header and rejects other formats, while camera frames and
    // uploaded photos arrive as JPEG. Only the recognizer under it is faked.
    const recognized: Buffer[] = [];
    const adapter = new RapidOcrCoordAdapter({
      extractText: async (buffer) => {
        recognized.push(buffer);
        return {
          text: "EXIT 12",
          fullText: "EXIT 12",
          blocks: [
            {
              text: "EXIT 12",
              confidence: 0.95,
              bbox: { x: 10, y: 10, width: 80, height: 20 },
            },
          ],
        };
      },
    });
    const jpeg = await sharp({
      create: {
        width: 120,
        height: 60,
        channels: 3,
        background: { r: 240, g: 240, b: 240 },
      },
    })
      .jpeg()
      .toBuffer();
    const aug = new FusedVisionContextAugmenter({ getOcr: () => adapter });
    const out = await aug.augmentImagePrompt({
      image: {
        kind: "dataUrl",
        dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      },
    });
    expect(out?.fused.ocrText).toBe('"EXIT 12"');
    expect(recognized).toHaveLength(1);
    expect(readPngDimensionsOrNull(recognized[0])).toEqual({
      width: 120,
      height: 60,
    });
  });

  it("skips OCR with the decoder's reason when the image cannot become PNG", async () => {
    const { logger } = await import("@elizaos/core");
    const debug = vi.spyOn(logger, "debug");
    let ocrRan = false;
    const aug = new FusedVisionContextAugmenter({
      getOcr: () => ({
        name: "spy-ocr",
        async describe(): Promise<OcrWithCoordsResult> {
          ocrRan = true;
          return { blocks: [] };
        },
      }),
    });
    const out = await aug.augmentImagePrompt({
      image: { kind: "bytes", bytes: new TextEncoder().encode("not an image") },
    });
    expect(out).toBeNull();
    expect(ocrRan).toBe(false);
    expect(debug.mock.calls.map((call) => String(call[0]))).toContainEqual(
      expect.stringMatching(
        /^\[vision-augment\] OCR skipped: image could not be converted to PNG: .*unsupported image format/,
      ),
    );
    debug.mockRestore();
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

// Model encoding (quint/VisionDescribeOcr.qnt): image 0 PNG, 1 JPEG, 2 bytes
// no decoder reads; backend 0 the image backend loads, 1 it fails to load;
// ocrInput -1 OCR not called, 0 PNG bytes, 1 JPEG bytes, 2 unreadable bytes;
// reason 0 none, 1 conversion failed, 2 backend unavailable, 3 the coord
// adapter rejected the PNG header.
interface DescribeOcrModelCase {
  image: number;
  hasText: boolean;
  backend: number;
  ocrInput: number;
  passThrough: boolean;
  reason: number;
  ocrText: boolean;
}
const DESCRIBE_OCR_MODEL_CASES: DescribeOcrModelCase[] = process.env
  .ELIZA_VISION_DESCRIBE_OCR_MODEL_CASES
  ? JSON.parse(
      readFileSync(process.env.ELIZA_VISION_DESCRIBE_OCR_MODEL_CASES, "utf8"),
    )
  : [0, 1, 2].flatMap((image) =>
      [false, true].flatMap((hasText) =>
        [0, 1].map((backend) => {
          const converted = image === 0 || (image === 1 && backend === 0);
          return {
            image,
            hasText,
            backend,
            ocrInput: converted ? 0 : -1,
            passThrough: image === 0,
            reason: converted ? 0 : backend === 1 ? 2 : 1,
            ocrText: converted && hasText,
          };
        }),
      ),
    );
const SKIP_REASON_PREFIX: Record<number, string> = {
  1: "[vision-augment] OCR skipped: image could not be converted to PNG: ",
  2: "[vision-augment] OCR skipped: image backend unavailable to convert the image to PNG: ",
  3: "[vision-augment] OCR skipped: readPngDimensions: ",
};
const MODEL_FIXTURE_PNG = readFileSync(
  fileURLToPath(
    new URL("../test/fixtures/ocr-real-sample.png", import.meta.url),
  ),
);

async function describeOcrModelImage(
  image: number,
  hasText: boolean,
): Promise<Buffer> {
  if (image === 2) return Buffer.from("not an image: truncated upload");
  const png = hasText
    ? MODEL_FIXTURE_PNG
    : await sharp({
        create: {
          width: 800,
          height: 240,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();
  return image === 0 ? png : sharp(png).jpeg({ quality: 90 }).toBuffer();
}

describe("vision describe OCR model cases", () => {
  afterEach(() => {
    vi.doUnmock("./image/sharp-compat.js");
    vi.resetModules();
  });

  it.each(DESCRIBE_OCR_MODEL_CASES)(
    "matches the generated describe OCR outcome (image $image, text $hasText, backend $backend)",
    async (modelCase) => {
      vi.resetModules();
      if (modelCase.backend === 1) {
        // The image backend fails to load (an app bundle without sharp or
        // jimp). Only the loader is replaced; the augmenter, adapter and
        // PNG checks are the production modules.
        vi.doMock("./image/sharp-compat.js", () => ({
          getSharp: async () => {
            throw new Error("no image backend in this bundle");
          },
        }));
      }
      const { logger } = await import("@elizaos/core");
      const augmenterModule = await import("./vision-context-augmenter.js");
      const coordModule = await import("./ocr-with-coords.js");
      const debug = vi.spyOn(logger, "debug");
      const input = await describeOcrModelImage(
        modelCase.image,
        modelCase.hasText,
      );
      // RapidOcrCoordAdapter is the production coord-OCR service on macOS
      // and wherever no other engine is found; its recognizer (Apple Vision
      // or doCTR) does not run on Linux CI, so a recorder stands in for it.
      const recognized: Buffer[] = [];
      const adapter = new coordModule.RapidOcrCoordAdapter({
        extractText: async (buffer) => {
          recognized.push(buffer);
          const text = modelCase.hasText ? "Eliza OCR" : "";
          return {
            text,
            fullText: text,
            blocks: modelCase.hasText
              ? [
                  {
                    text,
                    confidence: 0.9,
                    bbox: { x: 40, y: 40, width: 200, height: 40 },
                  },
                ]
              : [],
          };
        },
      });
      try {
        const out = await new augmenterModule.FusedVisionContextAugmenter({
          getOcr: () => adapter,
        }).augmentImagePrompt({
          image: { kind: "bytes", bytes: new Uint8Array(input) },
        });
        const skipped = debug.mock.calls
          .map((call) => String(call[0]))
          .filter((message) =>
            message.startsWith("[vision-augment] OCR skipped: "),
          );
        expect(out?.fused.ocrText).toBe(
          modelCase.ocrText ? '"Eliza OCR"' : undefined,
        );
        expect(recognized).toHaveLength(modelCase.ocrInput === 0 ? 1 : 0);
        if (modelCase.ocrInput === 0) {
          expect(readPngDimensionsOrNull(recognized[0])).toEqual({
            width: 800,
            height: 240,
          });
          expect(recognized[0].equals(input)).toBe(modelCase.passThrough);
        }
        if (modelCase.reason === 0) {
          expect(skipped).toEqual([]);
        } else {
          expect(skipped).toHaveLength(1);
          expect(skipped[0]).toContain(SKIP_REASON_PREFIX[modelCase.reason]);
        }
      } finally {
        debug.mockRestore();
      }
    },
  );
});
