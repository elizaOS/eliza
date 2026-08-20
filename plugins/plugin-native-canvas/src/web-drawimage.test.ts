// @vitest-environment jsdom

/**
 * Regression tests for `CanvasWeb.drawImage` save/restore balance. Exercises
 * the real `CanvasWeb` against a stubbed 2D context (jsdom has no canvas
 * renderer) with a fake `Image` whose `src` setter fires `onload`/`onerror`
 * asynchronously. Guards the contract that a failed image load must not leak
 * the `ctx.save()` frame or the mutated draw-option state (globalAlpha,
 * blendMode, shadow, transform) onto later unrelated draws, and that the
 * success path still restores exactly once while drawing at the requested
 * opacity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasWeb } from "./web";

interface CountingContext extends CanvasRenderingContext2D {
  saveCount: number;
  restoreCount: number;
  fillAlphas: number[];
  drawImageAlphas: number[];
}

/**
 * A 2D context stub that tracks save/restore balance and records
 * `globalAlpha` at the moment `fill()` and `drawImage()` are invoked, so a
 * leaked alpha from a prior draw is observable on a later one.
 */
function createCountingContext(): CountingContext {
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    saveCount: 0,
    restoreCount: 0,
    fillAlphas: [] as number[],
    drawImageAlphas: [] as number[],
    save(this: CountingContext) {
      this.saveCount += 1;
    },
    restore(this: CountingContext) {
      this.restoreCount += 1;
      this.globalAlpha = 1;
    },
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    rect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    transform: vi.fn(),
    setTransform: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    })),
    putImageData: vi.fn(),
  } as unknown as CountingContext;

  ctx.fill = vi.fn(function fill(this: CountingContext) {
    this.fillAlphas.push(this.globalAlpha);
  }) as unknown as CanvasRenderingContext2D["fill"];
  ctx.drawImage = vi.fn(function drawImage(this: CountingContext) {
    this.drawImageAlphas.push(this.globalAlpha);
  }) as unknown as CanvasRenderingContext2D["drawImage"];

  return ctx;
}

/**
 * Replaces the global `Image` with a fake whose `src` setter schedules
 * `onerror` (load failure) or `onload` (success) on a microtask, matching how
 * a real browser resolves image loads asynchronously.
 */
function installFakeImage(outcome: "error" | "load"): void {
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = "";
    set src(value: string) {
      this._src = value;
      queueMicrotask(() => {
        if (outcome === "error") {
          this.onerror?.();
        } else {
          this.onload?.();
        }
      });
    }
    get src(): string {
      return this._src;
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

describe("CanvasWeb.drawImage save/restore balance", () => {
  let ctx: CountingContext;

  beforeEach(() => {
    ctx = createCountingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("balances save/restore when the image fails to load", async () => {
    installFakeImage("error");
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    ctx.saveCount = 0;
    ctx.restoreCount = 0;

    await expect(
      canvas.drawImage({
        canvasId,
        image: "https://example.invalid/missing.png",
        destRect: { x: 0, y: 0, width: 10, height: 10 },
        drawOptions: { opacity: 0.5 },
      }),
    ).rejects.toThrow("Failed to load image");

    // The save() frame must be fully unwound even though drawImage rejected.
    expect(ctx.saveCount).toBe(ctx.restoreCount);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("does not leak the failed draw opacity onto a later drawRect", async () => {
    installFakeImage("error");
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });

    await expect(
      canvas.drawImage({
        canvasId,
        image: "https://example.invalid/missing.png",
        destRect: { x: 0, y: 0, width: 10, height: 10 },
        drawOptions: { opacity: 0.5 },
      }),
    ).rejects.toThrow("Failed to load image");

    // A subsequent fully-opaque rectangle must fill at alpha 1, not the 0.5
    // requested by the failed image draw.
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 5, height: 5 },
      fill: { color: { r: 255, g: 0, b: 0 } },
    });

    expect(ctx.fillAlphas).toEqual([1]);
  });

  it("restores exactly once and draws at the requested opacity on success", async () => {
    installFakeImage("load");
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    ctx.saveCount = 0;
    ctx.restoreCount = 0;

    await canvas.drawImage({
      canvasId,
      image: "https://example.test/ok.png",
      destRect: { x: 0, y: 0, width: 10, height: 10 },
      drawOptions: { opacity: 0.5 },
    });

    // Success path: one save, one restore, and the image drawn at 0.5 alpha.
    expect(ctx.saveCount).toBe(1);
    expect(ctx.restoreCount).toBe(1);
    expect(ctx.drawImageAlphas).toEqual([0.5]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("does not leak opacity through a failed drawBatch image command", async () => {
    installFakeImage("error");
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });

    // drawImage is also reachable via drawBatch({type:"image"}).
    await expect(
      canvas.drawBatch({
        canvasId,
        commands: [
          {
            type: "image",
            args: {
              image: "https://example.invalid/missing.png",
              destRect: { x: 0, y: 0, width: 10, height: 10 },
              drawOptions: { opacity: 0.5 },
            },
          },
        ],
      }),
    ).rejects.toThrow("Failed to load image");

    expect(ctx.saveCount).toBe(ctx.restoreCount);
    expect(ctx.globalAlpha).toBe(1);
  });
});
