// Synthetic fixture builders used by the analyzer suites: every exported
// helper must produce a real decodable image whose pixels match its contract,
// so these tests decode each written PNG back through sharp and inspect the
// raw channel data instead of trusting return values.
import { existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  gradientPng,
  makeTmpDir,
  rectPng,
  solidPng,
  textPng,
} from "./test-fixtures.ts";

const dir = makeTmpDir();
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function rawPixels(file: string): Promise<RawImage> {
  const { data, info } = await sharp(file)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function rgbAt(img: RawImage, x: number, y: number): [number, number, number] {
  const i = (y * img.width + x) * img.channels;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

describe("makeTmpDir", () => {
  it("creates an existing directory under the OS temp root", () => {
    const made = makeTmpDir();
    expect(existsSync(made)).toBe(true);
    expect(statSync(made).isDirectory()).toBe(true);
    expect(made.startsWith(tmpdir() + sep)).toBe(true);
  });

  it("uses the default evidence-analyzers- prefix and honours a custom one", () => {
    expect(basename(makeTmpDir())).toMatch(/^evidence-analyzers-/);
    expect(basename(makeTmpDir("coverage-"))).toMatch(/^coverage-/);
  });

  it("returns a distinct directory on every call", () => {
    const a = makeTmpDir();
    const b = makeTmpDir();
    expect(a).not.toBe(b);
  });
});

describe("solidPng", () => {
  it("writes a decodable PNG and returns the exact path written", async () => {
    const target = join(dir, "solid-default.png");
    const returned = await solidPng(target, [10, 20, 30]);
    expect(returned).toBe(target);
    expect(existsSync(target)).toBe(true);
    const meta = await sharp(target).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(120);
  });

  it("fills every pixel with the requested RGB at the default size", async () => {
    const img = await rawPixels(
      await solidPng(join(dir, "solid-fill.png"), [10, 20, 30]),
    );
    expect(img.width).toBe(120);
    expect(img.height).toBe(120);
    for (let i = 0; i < img.data.length; i += img.channels) {
      expect([img.data[i], img.data[i + 1], img.data[i + 2]]).toEqual([
        10, 20, 30,
      ]);
    }
  });

  it("honours explicit width and height overrides", async () => {
    const img = await rawPixels(
      await solidPng(join(dir, "solid-sized.png"), [255, 0, 0], 4, 3),
    );
    expect(img.width).toBe(4);
    expect(img.height).toBe(3);
    expect(rgbAt(img, 3, 2)).toEqual([255, 0, 0]);
  });
});

describe("rectPng", () => {
  it("returns the path and renders a 240x240 canvas by default", async () => {
    const target = join(dir, "rect-default.png");
    const returned = await rectPng(
      target,
      [1, 2, 3],
      { left: 5, top: 6, width: 8, height: 4 },
      [200, 210, 220],
    );
    expect(returned).toBe(target);
    const meta = await sharp(target).metadata();
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(240);
  });

  it("paints exactly the rectangle with rectColor over the base fill", async () => {
    const rect = { left: 5, top: 6, width: 8, height: 4 };
    const img = await rawPixels(
      await rectPng(
        join(dir, "rect-region.png"),
        [1, 2, 3],
        rect,
        [200, 210, 220],
      ),
    );
    expect(rgbAt(img, rect.left + 3, rect.top + 2)).toEqual([200, 210, 220]);
    expect(rgbAt(img, rect.left, rect.top)).toEqual([200, 210, 220]);
    expect(rgbAt(img, 0, 0)).toEqual([1, 2, 3]);
    const bottomRight = rgbAt(img, img.width - 1, img.height - 1);
    expect(bottomRight).toEqual([1, 2, 3]);
  });

  it("honours explicit canvas dimensions around the rectangle", async () => {
    const img = await rawPixels(
      await rectPng(
        join(dir, "rect-sized.png"),
        [9, 8, 7],
        { left: 1, top: 1, width: 2, height: 2 },
        [50, 60, 70],
        32,
        16,
      ),
    );
    expect(img.width).toBe(32);
    expect(img.height).toBe(16);
    expect(rgbAt(img, 2, 2)).toEqual([50, 60, 70]);
    expect(rgbAt(img, 31, 15)).toEqual([9, 8, 7]);
  });
});

describe("textPng", () => {
  it("renders a decodable white-background PNG at the default size", async () => {
    const target = join(dir, "text-default.png");
    const returned = await textPng(target, "EVIDENCE");
    expect(returned).toBe(target);
    const meta = await sharp(target).metadata();
    expect(meta.width).toBe(640);
    expect(meta.height).toBe(160);
  });

  it("draws dark glyph pixels on a white background", async () => {
    const img = await rawPixels(
      await textPng(join(dir, "text-glyphs.png"), "HELLO"),
    );
    let darkest = 255;
    let darkPixels = 0;
    for (let i = 0; i < img.data.length; i += img.channels) {
      if (img.data[i] < darkest) darkest = img.data[i];
      if (img.data[i] < 128) darkPixels++;
    }
    expect(darkest).toBeLessThan(128);
    expect(darkPixels).toBeGreaterThan(0);
  });

  it("honours explicit canvas dimensions", async () => {
    const meta = await sharp(
      await textPng(join(dir, "text-sized.png"), "WIDE", 320, 80),
    ).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(80);
  });
});

describe("gradientPng", () => {
  it("writes a decodable grayscale ramp at the default size", async () => {
    const target = join(dir, "gradient-default.png");
    const returned = await gradientPng(target);
    expect(returned).toBe(target);
    const img = await rawPixels(target);
    expect(img.width).toBe(128);
    expect(img.height).toBe(128);
    expect(rgbAt(img, 0, 0)).toEqual([0, 0, 0]);
    expect(rgbAt(img, img.width - 1, 0)).toEqual([255, 255, 255]);
  });

  it("increases monotonically left to right along a row", async () => {
    const img = await rawPixels(await gradientPng(join(dir, "g-row.png")));
    for (let y = 0; y < img.height; y += Math.floor(img.height / 4)) {
      let previous = -1;
      for (let x = 0; x < img.width; x++) {
        const [v] = rgbAt(img, x, y);
        expect(v).toBeGreaterThanOrEqual(previous);
        previous = v;
      }
    }
  });

  it("keeps columns constant down the image", async () => {
    const img = await rawPixels(await gradientPng(join(dir, "g-col.png")));
    for (let x = 0; x < img.width; x += Math.floor(img.width / 4)) {
      const top = rgbAt(img, x, 0);
      for (let y = 1; y < img.height; y++) {
        expect(rgbAt(img, x, y)).toEqual(top);
      }
    }
  });

  it("produces equal R, G and B for every pixel (true grayscale)", async () => {
    const img = await rawPixels(await gradientPng(join(dir, "g-gray.png")));
    for (let i = 0; i < img.data.length; i += img.channels) {
      expect(img.data[i]).toBe(img.data[i + 1]);
      expect(img.data[i + 1]).toBe(img.data[i + 2]);
    }
  });

  it("honours explicit dimensions", async () => {
    const img = await rawPixels(
      await gradientPng(join(dir, "g-sized.png"), 16, 8),
    );
    expect(img.width).toBe(16);
    expect(img.height).toBe(8);
    expect(rgbAt(img, 15, 7)).toEqual([255, 255, 255]);
  });
});
