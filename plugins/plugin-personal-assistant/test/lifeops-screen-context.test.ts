/**
 * Covers screen-context sampling without eagerly loading sharp: sharp stays unloaded on
 * import, and sampling works through an injected image analyzer. Deterministic, temp-file
 * frames.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempRoots: string[] = [];

async function writeTempFrame(bytes: Buffer): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeops-screen-"));
  tempRoots.push(tempRoot);
  const framePath = path.join(tempRoot, "frame.png");
  await writeFile(framePath, bytes);
  return framePath;
}

describe("LifeOps screen context", () => {
  afterEach(async () => {
    vi.doUnmock("sharp");
    vi.resetModules();
    await Promise.all(
      tempRoots
        .splice(0)
        .map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    );
  });

  it("does not load sharp when the module is imported", async () => {
    vi.resetModules();
    const sharpFactory = vi.fn(() => {
      throw new Error("sharp should only load while analyzing an image");
    });
    vi.doMock("sharp", () => sharpFactory());

    const mod = await import("../src/lifeops/screen-context.js");

    expect(mod.LifeOpsScreenContextSampler).toBeDefined();
    expect(sharpFactory).not.toHaveBeenCalled();
  });

  it("samples with an injected image analyzer without loading sharp", async () => {
    vi.resetModules();
    const sharpFactory = vi.fn(() => {
      throw new Error("sharp should not load when an analyzer is injected");
    });
    vi.doMock("sharp", () => sharpFactory());
    const { LifeOpsScreenContextSampler } = await import(
      "../src/lifeops/screen-context.js"
    );
    const frameBytes = Buffer.from("fake image bytes");
    const framePath = await writeTempFrame(frameBytes);
    const imageAnalyzer = {
      analyze: vi.fn(async (imageBuffer: Buffer) => {
        expect(imageBuffer.equals(frameBytes)).toBe(true);
        return {
          width: 2,
          height: 3,
          averageLuma: 0.45,
          lumaStdDev: 0.12,
          darkRatio: 0.1,
          brightRatio: 0.1,
          edgeRatio: 0.12,
        };
      }),
    };

    const sampler = new LifeOpsScreenContextSampler({
      framePath,
      minSampleIntervalMs: 0,
      maxFrameAgeMs: 60_000,
      imageAnalyzer,
      ocr: {
        async extractText() {
          return "Inbox Calendar Meeting Terminal";
        },
      },
    });

    const summary = await sampler.sample(Date.now());

    expect(imageAnalyzer.analyze).toHaveBeenCalledTimes(1);
    expect(sharpFactory).not.toHaveBeenCalled();
    expect(summary.source).toBe("vision");
    expect(summary.available).toBe(true);
    expect(summary.focus).toBe("work");
    expect(summary.width).toBe(2);
    expect(summary.height).toBe(3);
  });

  it("analyzes images through sharp's callable default export", async () => {
    vi.resetModules();
    const pixels = Buffer.from([64, 192]);
    const pipeline = {
      rotate: vi.fn(() => pipeline),
      greyscale: vi.fn(() => pipeline),
      resize: vi.fn(() => pipeline),
      raw: vi.fn(() => pipeline),
      toBuffer: vi.fn(async () => ({
        data: pixels,
        info: { width: 2, height: 1 },
      })),
    };
    const sharpFactory = vi.fn(() => pipeline);
    vi.doMock("sharp", () => ({ default: sharpFactory }));
    const { analyzeLifeOpsScreenBuffer } = await import(
      "../src/lifeops/screen-context.js"
    );
    const frameBytes = Buffer.from("image bytes");

    const summary = await analyzeLifeOpsScreenBuffer({
      framePath: "/tmp/frame.png",
      frameBytes,
      ocrText: null,
      capturedAtMs: 1,
      sampledAtMs: 2,
      stale: false,
    });

    expect(sharpFactory).toHaveBeenCalledWith(frameBytes);
    expect(pipeline.rotate).toHaveBeenCalledOnce();
    expect(pipeline.greyscale).toHaveBeenCalledOnce();
    expect(summary.available).toBe(true);
    expect(summary.width).toBe(2);
    expect(summary.height).toBe(1);
  });
});
