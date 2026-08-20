// @vitest-environment jsdom

/**
 * Composite-contract tests for `CanvasWeb.toImage` — the web/Electrobun
 * export must match the native iOS/Android bridges: the default (no
 * `layerIds`) export composites the base surface plus every visible layer
 * sorted by z-index, and an explicit `layerIds` subset restricts the export
 * to those named layers. Runs against a real `CanvasWeb` in jsdom with the 2D
 * context stubbed (jsdom has no canvas renderer); every `drawImage` source is
 * recorded so the composited surfaces can be asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasWeb } from "./web";

const drawImageSources: HTMLCanvasElement[] = [];

function createContextStub(): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn((source: CanvasImageSource) => {
      drawImageSources.push(source as HTMLCanvasElement);
    }),
    ellipse: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    getImageData: vi.fn(() => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
    })),
    globalAlpha: 1,
    putImageData: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    toDataURL: vi.fn(() => "data:image/png;base64,ZmFrZQ=="),
  } as unknown as CanvasRenderingContext2D;
}

function lastCanvas(host: HTMLElement): HTMLCanvasElement {
  const all = host.querySelectorAll("canvas");
  return all[all.length - 1] as HTMLCanvasElement;
}

describe("CanvasWeb.toImage composite contract", () => {
  beforeEach(() => {
    drawImageSources.length = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (() => createContextStub()) as never,
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,ZmFrZQ==",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  async function setup(): Promise<{
    canvas: CanvasWeb;
    canvasId: string;
    host: HTMLElement;
    baseEl: HTMLCanvasElement;
  }> {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 100, height: 100 },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    await canvas.attach({ canvasId, element: host });
    const baseEl = lastCanvas(host);
    return { canvas, canvasId, host, baseEl };
  }

  it("composites the base surface plus a visible layer in the default export", async () => {
    const { canvas, canvasId, host, baseEl } = await setup();
    const { layerId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 0 },
    });
    const layerEl = lastCanvas(host);
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      fill: { color: "#ff0000" },
      drawOptions: { layerId },
    });

    drawImageSources.length = 0;
    const result = await canvas.toImage({ canvasId, format: "png" });

    expect(result.format).toBe("png");
    // Regression: the visible layer surface must participate in the export.
    expect(drawImageSources).toContain(baseEl);
    expect(drawImageSources).toContain(layerEl);
    // Base is composited before the layer that sits on top of it.
    expect(drawImageSources[0]).toBe(baseEl);
    expect(drawImageSources[1]).toBe(layerEl);
  });

  it("omits a hidden layer from the default export", async () => {
    const { canvas, canvasId, host, baseEl } = await setup();
    await canvas.createLayer({
      canvasId,
      layer: { visible: false, opacity: 1, zIndex: 0 },
    });
    const hiddenEl = lastCanvas(host);

    drawImageSources.length = 0;
    await canvas.toImage({ canvasId, format: "png" });

    expect(drawImageSources).toContain(baseEl);
    expect(drawImageSources).not.toContain(hiddenEl);
  });

  it("composites visible layers in ascending z-index order", async () => {
    const { canvas, canvasId, host, baseEl } = await setup();
    // Create the higher z-index layer first to prove ordering follows
    // zIndex, not creation order.
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 0.5, zIndex: 5 },
    });
    const highEl = lastCanvas(host);
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 0.5, zIndex: 1 },
    });
    const lowEl = lastCanvas(host);

    drawImageSources.length = 0;
    await canvas.toImage({ canvasId, format: "png" });

    expect(drawImageSources).toEqual([baseEl, lowEl, highEl]);
  });

  it("restricts the export to the named layerIds subset and omits the base", async () => {
    const { canvas, canvasId, host, baseEl } = await setup();
    const { layerId: firstId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 0 },
    });
    const firstEl = lastCanvas(host);
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });
    const secondEl = lastCanvas(host);

    drawImageSources.length = 0;
    await canvas.toImage({ canvasId, format: "png", layerIds: [firstId] });

    expect(drawImageSources).toEqual([firstEl]);
    expect(drawImageSources).not.toContain(baseEl);
    expect(drawImageSources).not.toContain(secondEl);
  });

  it("preserves caller-provided order for an explicit layerIds subset", async () => {
    const { canvas, canvasId, host } = await setup();
    const { layerId: lowId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });
    const lowEl = lastCanvas(host);
    const { layerId: highId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 5 },
    });
    const highEl = lastCanvas(host);

    drawImageSources.length = 0;
    await canvas.toImage({
      canvasId,
      format: "png",
      layerIds: [highId, lowId],
    });

    expect(drawImageSources).toEqual([highEl, lowEl]);
  });
});
