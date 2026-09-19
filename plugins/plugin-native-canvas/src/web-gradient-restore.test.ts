// @vitest-environment jsdom

/**
 * Regression tests for the save/restore balance of `CanvasWeb`'s synchronous
 * draw methods (`drawRect`, `drawEllipse`, `drawPath`, `drawLine`, `drawText`)
 * when a step between `ctx.save()` and `ctx.restore()` throws mid-draw.
 * Exercises the real `CanvasWeb` against a stubbed 2D context whose
 * `createRadialGradient`/`createLinearGradient` and `addColorStop` reproduce
 * the browser's `IndexSizeError`/`SyntaxError` behavior for malformed
 * gradients, and covers a throw raised inside `applyDrawOptions` itself (a
 * malformed shadow color) after `save()` has already pushed the frame, plus a
 * malformed stroke/text color that throws from `colorToString` in `drawLine`
 * and `drawText` after `save()`. Guards
 * the contract that such a throw must not leak the `ctx.save()` frame or the
 * mutated draw-option state (globalAlpha, blendMode, shadow, transform) onto
 * later unrelated draws — the same balance invariant the async `drawImage`
 * path holds — while the success path still restores exactly once at the
 * requested opacity.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasWeb } from "./web";

interface CountingContext extends CanvasRenderingContext2D {
  saveCount: number;
  restoreCount: number;
  fillAlphas: number[];
}

/**
 * A 2D context stub that tracks save/restore balance, records `globalAlpha`
 * at each `fill()`, and models the real browser exceptions thrown by
 * `createRadialGradient` (negative radius) and `addColorStop` (offset outside
 * [0,1] or an unparseable color). A leaked alpha from a prior failed draw is
 * therefore observable on a later successful one.
 */
function createCountingContext(): CountingContext {
  const ctx = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    textAlign: "left",
    textBaseline: "alphabetic",
    saveCount: 0,
    restoreCount: 0,
    fillAlphas: [] as number[],
    save(this: CountingContext) {
      this.saveCount += 1;
    },
    restore(this: CountingContext) {
      this.restoreCount += 1;
      this.globalAlpha = 1;
      this.globalCompositeOperation = "source-over";
      this.shadowBlur = 0;
    },
    beginPath: vi.fn(),
    closePath: vi.fn(),
    clearRect: vi.fn(),
    rect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    ellipse: vi.fn(),
    arc: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    transform: vi.fn(),
    setTransform: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    createLinearGradient: vi.fn(() => makeGradientStub()),
    createRadialGradient: vi.fn(
      (
        _x0: number,
        _y0: number,
        r0: number,
        _x1: number,
        _y1: number,
        r1: number,
      ) => {
        if (r0 < 0 || r1 < 0) {
          throw new DOMException(
            "The radius provided is negative.",
            "IndexSizeError",
          );
        }
        return makeGradientStub();
      },
    ),
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

  return ctx;
}

/**
 * A gradient stub whose `addColorStop` throws the way a browser does for an
 * offset outside [0,1], matching `CanvasGradient.addColorStop`.
 */
function makeGradientStub(): CanvasGradient {
  return {
    addColorStop(offset: number) {
      if (offset < 0 || offset > 1) {
        throw new DOMException(
          "The provided value is outside the range [0, 1].",
          "IndexSizeError",
        );
      }
    },
  } as unknown as CanvasGradient;
}

describe("CanvasWeb synchronous draw save/restore balance on gradient failure", () => {
  let ctx: CountingContext;

  beforeEach(() => {
    ctx = createCountingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  async function makeCanvas(): Promise<{
    canvas: CanvasWeb;
    canvasId: string;
  }> {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    ctx.saveCount = 0;
    ctx.restoreCount = 0;
    return { canvas, canvasId };
  }

  it("drawRect with a negative-radius radial gradient balances save/restore", async () => {
    const { canvas, canvasId } = await makeCanvas();

    await expect(
      canvas.drawRect({
        canvasId,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        fill: {
          type: "radial",
          x0: 5,
          y0: 5,
          r0: -1,
          x1: 5,
          y1: 5,
          r1: 5,
          stops: [
            { offset: 0, color: { r: 255, g: 0, b: 0 } },
            { offset: 1, color: { r: 0, g: 0, b: 255 } },
          ],
        },
        drawOptions: { opacity: 0.5 },
      }),
    ).rejects.toThrow();

    // The save() frame must be fully unwound even though the fill threw.
    expect(ctx.saveCount).toBe(ctx.restoreCount);
    expect(ctx.saveCount).toBe(1);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("does not leak the failed draw opacity onto a later plain drawRect", async () => {
    const { canvas, canvasId } = await makeCanvas();

    await expect(
      canvas.drawRect({
        canvasId,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        fill: {
          type: "radial",
          x0: 5,
          y0: 5,
          r0: -1,
          x1: 5,
          y1: 5,
          r1: 5,
          stops: [{ offset: 0, color: { r: 255, g: 0, b: 0 } }],
        },
        drawOptions: { opacity: 0.5 },
      }),
    ).rejects.toThrow();

    // A later fully-opaque rectangle must fill at alpha 1, not the leaked 0.5.
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 5, height: 5 },
      fill: { color: { r: 255, g: 0, b: 0 } },
    });

    expect(ctx.fillAlphas).toEqual([1]);
  });

  it("drawEllipse balances save/restore when the gradient fill throws", async () => {
    const { canvas, canvasId } = await makeCanvas();

    await expect(
      canvas.drawEllipse({
        canvasId,
        center: { x: 5, y: 5 },
        radiusX: 4,
        radiusY: 4,
        fill: {
          type: "radial",
          x0: 5,
          y0: 5,
          r0: -3,
          x1: 5,
          y1: 5,
          r1: 4,
          stops: [{ offset: 0, color: { r: 0, g: 255, b: 0 } }],
        },
        drawOptions: { opacity: 0.25 },
      }),
    ).rejects.toThrow();

    expect(ctx.saveCount).toBe(ctx.restoreCount);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("drawPath balances save/restore when a color stop offset is out of range", async () => {
    const { canvas, canvasId } = await makeCanvas();

    await expect(
      canvas.drawPath({
        canvasId,
        path: {
          commands: [
            { type: "moveTo", args: [0, 0] },
            { type: "lineTo", args: [10, 10] },
            { type: "closePath", args: [] },
          ],
        },
        fill: {
          type: "linear",
          x0: 0,
          y0: 0,
          x1: 10,
          y1: 10,
          // 1.5 is outside [0,1] -> addColorStop throws IndexSizeError.
          stops: [{ offset: 1.5, color: { r: 10, g: 20, b: 30 } }],
        },
        drawOptions: { opacity: 0.75 },
      }),
    ).rejects.toThrow();

    expect(ctx.saveCount).toBe(ctx.restoreCount);
    expect(ctx.globalAlpha).toBe(1);
  });

  it("drawRect balances save/restore when a bad shadow color throws inside applyDrawOptions", async () => {
    const { canvas, canvasId } = await makeCanvas();

    // A null shadow.color crosses the plugin boundary as malformed JSON; it
    // throws a TypeError from colorToString AFTER ctx.save() and globalAlpha
    // have already been applied, inside applyDrawOptions. The frame must not
    // survive that throw.
    await expect(
      canvas.drawRect({
        canvasId,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        fill: { color: { r: 255, g: 0, b: 0 } },
        drawOptions: {
          opacity: 0.5,
          shadow: {
            color: null as unknown as { r: number; g: number; b: number },
            blur: 4,
            offsetX: 1,
            offsetY: 1,
          },
        },
      }),
    ).rejects.toThrow();

    expect(ctx.saveCount).toBe(ctx.restoreCount);
    expect(ctx.saveCount).toBe(1);
    expect(ctx.globalAlpha).toBe(1);

    // A later plain rectangle fills at alpha 1, proving the leaked frame and
    // opacity did not survive the throw inside applyDrawOptions.
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 5, height: 5 },
      fill: { color: { r: 0, g: 0, b: 255 } },
    });

    expect(ctx.fillAlphas).toEqual([1]);
  });

  it("drawLine balances save/restore when the stroke color is malformed", async () => {
    const { canvas, canvasId } = await makeCanvas();

    // A null stroke.color reaches colorToString via applyStrokeStyle and throws
    // a TypeError AFTER applyDrawOptions pushed the frame and set globalAlpha.
    await expect(
      canvas.drawLine({
        canvasId,
        from: { x: 0, y: 0 },
        to: { x: 5, y: 5 },
        stroke: {
          color: null as unknown as { r: number; g: number; b: number },
          width: 1,
        },
        drawOptions: { opacity: 0.5 },
      }),
    ).rejects.toThrow();

    expect(ctx.saveCount).toBe(ctx.restoreCount);

    // A later plain rectangle fills at alpha 1, proving the frame and opacity
    // did not leak from the failed drawLine.
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 5, height: 5 },
      fill: { color: { r: 0, g: 0, b: 255 } },
    });

    expect(ctx.fillAlphas).toEqual([1]);
  });

  it("drawText balances save/restore when the text color is malformed", async () => {
    const { canvas, canvasId } = await makeCanvas();

    // A null style.color reaches colorToString and throws a TypeError AFTER
    // applyDrawOptions pushed the frame and set globalAlpha.
    await expect(
      canvas.drawText({
        canvasId,
        text: "hi",
        position: { x: 0, y: 0 },
        style: {
          font: "sans-serif",
          size: 12,
          color: null as unknown as { r: number; g: number; b: number },
        },
        drawOptions: { opacity: 0.5 },
      }),
    ).rejects.toThrow();

    expect(ctx.saveCount).toBe(ctx.restoreCount);

    // A later plain rectangle fills at alpha 1, proving the frame and opacity
    // did not leak from the failed drawText.
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 5, height: 5 },
      fill: { color: { r: 0, g: 0, b: 255 } },
    });

    expect(ctx.fillAlphas).toEqual([1]);
  });

  it("success path restores exactly once and fills at the requested opacity", async () => {
    const { canvas, canvasId } = await makeCanvas();

    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      fill: {
        type: "radial",
        x0: 5,
        y0: 5,
        r0: 0,
        x1: 5,
        y1: 5,
        r1: 5,
        stops: [
          { offset: 0, color: { r: 255, g: 0, b: 0 } },
          { offset: 1, color: { r: 0, g: 0, b: 255 } },
        ],
      },
      drawOptions: { opacity: 0.5 },
    });

    expect(ctx.saveCount).toBe(1);
    expect(ctx.restoreCount).toBe(1);
    expect(ctx.fillAlphas).toEqual([0.5]);
    expect(ctx.globalAlpha).toBe(1);
  });
});
