// Colour analyzers and shared colour math on synthetic sharp fixtures: palette
// on a solid frame, corner swatches on a synthetic 4-colour image, and the
// bucket classifier / whole-frame fractions the brand rule depends on. Fully
// deterministic — no external tools.
import { rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  colorCornersAnalyzer,
  colorPaletteAnalyzer,
  cornerSwatches,
  dominantPalette,
} from "./color.ts";
import { classifyColor, colorFractionsFromRaw } from "./color-math.ts";
import { makeTmpDir, solidPng } from "./test-fixtures.ts";
import type { AnalyzerContext } from "./types.ts";

const dir = makeTmpDir();
const ctx: AnalyzerContext = { tier: "cpu" };
const inputFor = (absolutePath: string) => ({
  entry: {
    path: "visual/x/img.png",
    sha256: "0".repeat(64),
    bytes: 0,
    kind: "screenshot" as const,
    source: "test",
    producedBy: "test",
    createdAt: new Date().toISOString(),
  },
  absolutePath,
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("classifyColor", () => {
  it("classifies saturated blue, orange, and neutral distinctly", () => {
    expect(classifyColor(30, 60, 200)).toBe("blue");
    expect(classifyColor(220, 110, 40)).toBe("orange");
    expect(classifyColor(180, 180, 182)).toBe("neutral");
    expect(classifyColor(120, 60, 60)).toBe("other");
  });
});

describe("colorFractionsFromRaw", () => {
  it("reports a mostly-blue buffer as blue and no orange", () => {
    const buf = Buffer.alloc(3 * 100);
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = 30;
      buf[i + 1] = 60;
      buf[i + 2] = 200;
    }
    const f = colorFractionsFromRaw(buf, 3);
    expect(f.blue_fraction).toBe(1);
    expect(f.orange_fraction).toBe(0);
  });
});

describe("dominantPalette", () => {
  it("returns the fill colour as the dominant bucket", async () => {
    const pal = await dominantPalette(
      await solidPng(join(dir, "red.png"), [240, 16, 16]),
    );
    expect(pal[0].fraction).toBeGreaterThan(0.9);
    expect(pal[0].rgb[0]).toBeGreaterThan(200);
  });
});

describe("colorPaletteAnalyzer", () => {
  it("runs and returns swatches", async () => {
    const p = await solidPng(join(dir, "pal.png"), [10, 200, 10]);
    const result = await colorPaletteAnalyzer.analyze(inputFor(p), ctx);
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as { swatches: { rgb: number[] }[] };
    expect(data.swatches[0].rgb[1]).toBeGreaterThan(180);
  });
});

describe("color.corners", () => {
  it("samples four distinct corners of a synthetic quadrant image", async () => {
    // Compose a 200x200 image: TL red, TR green, BL blue, BR white.
    const quad = join(dir, "quad.png");
    const tile = (rgb: [number, number, number]) =>
      sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: rgb[0], g: rgb[1], b: rgb[2] },
        },
      })
        .png()
        .toBuffer();
    const [red, green, blue, white] = await Promise.all([
      tile([220, 20, 20]),
      tile([20, 200, 20]),
      tile([30, 60, 210]),
      tile([250, 250, 250]),
    ]);
    await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite([
        { input: red, left: 0, top: 0 },
        { input: green, left: 100, top: 0 },
        { input: blue, left: 0, top: 100 },
        { input: white, left: 100, top: 100 },
      ])
      .png()
      .toFile(quad);

    const swatches = await cornerSwatches(quad);
    const byPos = Object.fromEntries(swatches.map((s) => [s.position, s]));
    expect(byPos["top-left"].rgb[0]).toBeGreaterThan(180);
    expect(byPos["top-right"].rgb[1]).toBeGreaterThan(150);
    expect(byPos["bottom-left"].bucket).toBe("blue");
    expect(byPos["bottom-right"].bucket).toBe("neutral");
  });

  it("analyzer reports a blue corner via the bucket classifier", async () => {
    const p = await solidPng(join(dir, "allblue.png"), [30, 60, 210]);
    const result = await colorCornersAnalyzer.analyze(inputFor(p), ctx);
    expect(result.status).toBe("ran");
    if (result.status !== "ran") return;
    const data = result.data as { swatches: { bucket: string }[] };
    expect(data.swatches.every((s) => s.bucket === "blue")).toBe(true);
  });
});
