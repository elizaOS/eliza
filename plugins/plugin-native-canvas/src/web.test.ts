// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasWeb } from "./web";

function createContextStub(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    })),
    putImageData: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    toDataURL: vi.fn(() => "data:image/png;base64,ZmFrZQ=="),
  } as unknown as CanvasRenderingContext2D;
}

describe("CanvasWeb validation", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      createContextStub(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,ZmFrZQ==",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it.each([
    { width: 0, height: 100 },
    { width: -1, height: 100 },
    { width: Number.POSITIVE_INFINITY, height: 100 },
    { width: Number.NaN, height: 100 },
    { width: 20_000, height: 100 },
  ])("rejects malformed create size %#", async (size) => {
    await expect(new CanvasWeb().create({ size })).rejects.toThrow(
      /size\.(width|height)|between 1 and 16384/,
    );
  });

  it("rejects invalid attach targets before mutating the DOM", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });

    await expect(
      canvas.attach({
        canvasId,
        element: {} as HTMLElement,
      }),
    ).rejects.toThrow("element must be an HTMLElement-like append target");

    expect(document.querySelector("canvas")).toBeNull();
  });

  it("validates resize before changing the existing canvas dimensions", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 20 },
    });
    const host = document.createElement("div");
    await canvas.attach({ canvasId, element: host });

    await expect(
      canvas.resize({
        canvasId,
        size: { width: Number.POSITIVE_INFINITY, height: 40 },
      }),
    ).rejects.toThrow("size.width must be a finite number");

    const canvasElement = host.querySelector("canvas");
    expect(canvasElement?.width).toBe(10);
    expect(canvasElement?.height).toBe(20);
  });

  it.each([
    { visible: true, opacity: -0.1, zIndex: 1 },
    { visible: true, opacity: 1.1, zIndex: 1 },
    { visible: "yes", opacity: 1, zIndex: 1 },
    { visible: true, opacity: 1, zIndex: Number.NaN },
  ])("rejects malformed layer metadata %#", async (layer) => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });

    await expect(
      canvas.createLayer({
        canvasId,
        layer: layer as never,
      }),
    ).rejects.toThrow(/layer\.(visible|opacity|zIndex)/);
  });

  it("rejects invalid layer updates without changing the existing layer", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    const { layerId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 0.75, zIndex: 2 },
    });

    await expect(
      canvas.updateLayer({
        canvasId,
        layerId,
        layer: { opacity: Number.NaN },
      }),
    ).rejects.toThrow("layer.opacity must be a finite number");

    await expect(canvas.getLayers({ canvasId })).resolves.toEqual({
      layers: [
        {
          id: layerId,
          name: undefined,
          visible: true,
          opacity: 0.75,
          zIndex: 2,
          transform: undefined,
        },
      ],
    });
  });

  it.each([
    -1,
    101,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects invalid image quality %s", async (quality) => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });

    await expect(canvas.toImage({ canvasId, quality })).rejects.toThrow(
      /quality must/,
    );
  });
});
