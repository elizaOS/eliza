// @vitest-environment jsdom

/**
 * Regression test for layer zIndex sort safety during CanvasWeb.toImage compositing.
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

describe("CanvasWeb safe layer sorting", () => {
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

  it("composites multiple visible layers in ascending zIndex order without crash", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 100, height: 100 },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    await canvas.attach({ canvasId, element: host });
    const baseEl = lastCanvas(host);

    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 10 },
    });
    const layer10El = lastCanvas(host);

    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });
    const layer1El = lastCanvas(host);

    drawImageSources.length = 0;
    const result = await canvas.toImage({ canvasId, format: "png" });

    expect(result.format).toBe("png");
    expect(drawImageSources).toEqual([baseEl, layer1El, layer10El]);
  });
});
