// @vitest-environment jsdom

/**
 * Input-validation and web-view messaging boundary tests for `CanvasWeb`.
 * Runs real plugin instances in jsdom with only the unavailable 2D rendering
 * context stubbed; browser-engine postMessage behavior is covered separately
 * by the review evidence harness.
 */

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

  it.each([-1, 101, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid image quality %s",
    async (quality) => {
      const canvas = new CanvasWeb();
      const { canvasId } = await canvas.create({
        size: { width: 10, height: 10 },
      });

      await expect(canvas.toImage({ canvasId, quality })).rejects.toThrow(
        /quality must/,
      );
    },
  );
});

describe("CanvasWeb eval message source", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("ignores a spoofed eliza:evalResult from a window that is not the web view", async () => {
    const canvas = new CanvasWeb();
    await canvas.navigate({ url: "about:blank" });
    const iframe = document.querySelector("iframe");
    const webView = iframe?.contentWindow;
    expect(webView).toBeTruthy();

    const evalPromise = canvas.eval({ script: "1+1" });
    // Same-page attacker: window.postMessage delivers source === window.
    window.postMessage({ type: "eliza:evalResult", result: "pwned" }, "*");
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "eliza:evalResult", result: "2" },
        origin: window.location.origin,
        source: webView,
      }),
    );

    await expect(evalPromise).resolves.toEqual({ result: "2" });
  });

  it("pins postMessage targetOrigin to the navigation origin, not wildcard *", async () => {
    const canvas = new CanvasWeb();
    await canvas.navigate({ url: "https://canvas.eliza.how/view" });
    const iframe = document.querySelector("iframe");
    const webView = iframe?.contentWindow;
    expect(webView).toBeTruthy();
    if (!webView) throw new Error("Missing webView contentWindow");

    const postMessageSpy = vi.spyOn(webView, "postMessage");

    // 1. a2uiPush
    await canvas.a2uiPush({
      messages: [{ role: "assistant", type: "text", content: "hi" }],
    });
    expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "eliza:a2uiPush" }),
      "https://canvas.eliza.how",
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(expect.anything(), "*");

    // 2. a2uiReset
    postMessageSpy.mockClear();
    await canvas.a2uiReset();
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: "eliza:a2uiReset" },
      "https://canvas.eliza.how",
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(expect.anything(), "*");

    // 3. eval
    postMessageSpy.mockClear();
    const evalPromise = canvas.eval({ script: "document.title" });
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: "eliza:eval", script: "document.title" },
      "https://canvas.eliza.how",
    );
    expect(postMessageSpy).not.toHaveBeenCalledWith(expect.anything(), "*");

    // Complete eval
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "eliza:evalResult", result: "Canvas App" },
        origin: "https://canvas.eliza.how",
        source: webView,
      }),
    );
    await expect(evalPromise).resolves.toEqual({ result: "Canvas App" });
  });

  it("rejects an eval result from the right WindowProxy at the wrong origin", async () => {
    const canvas = new CanvasWeb();
    await canvas.navigate({ url: "https://canvas.eliza.how/view" });
    const webView = document.querySelector("iframe")?.contentWindow;
    expect(webView).toBeTruthy();

    const evalPromise = canvas.eval({ script: "document.title" });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "eliza:evalResult", result: "spoofed" },
        origin: "https://attacker.example",
        source: webView,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "eliza:evalResult", result: "Canvas App" },
        origin: "https://canvas.eliza.how",
        source: webView,
      }),
    );

    await expect(evalPromise).resolves.toEqual({ result: "Canvas App" });
  });

  it("rejects shared web view events from the right WindowProxy at the wrong origin", async () => {
    const canvas = new CanvasWeb();
    const onAction = vi.fn();
    await canvas.addListener("a2uiAction", onAction);
    await canvas.navigate({ url: "https://canvas.eliza.how/view" });
    const webView = document.querySelector("iframe")?.contentWindow;
    expect(webView).toBeTruthy();

    const message = {
      type: "eliza:a2uiAction",
      action: "confirm",
      data: { accepted: true },
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: "https://attacker.example",
        source: webView,
      }),
    );
    expect(onAction).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: message,
        origin: "https://canvas.eliza.how",
        source: webView,
      }),
    );
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith({
      action: "confirm",
      data: { accepted: true },
      messageId: undefined,
    });
  });

  it.each([
    ["about:blank?canvas#view", window.location.origin],
    ["blob:https://canvas.eliza.how/6fbed050", "https://canvas.eliza.how"],
  ])("resolves inherited and creator origins for %s", async (url, origin) => {
    const canvas = new CanvasWeb();
    await canvas.navigate({ url });
    const webView = document.querySelector("iframe")?.contentWindow;
    expect(webView).toBeTruthy();
    if (!webView) throw new Error("Missing webView contentWindow");
    const postMessageSpy = vi.spyOn(webView, "postMessage");

    await canvas.a2uiReset();

    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: "eliza:a2uiReset" },
      origin,
    );
  });

  it.each([
    "data:text/html,opaque",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "http://[",
  ])(
    "rejects non-allowlisted navigation %s before replacing the active view",
    async (url) => {
      const canvas = new CanvasWeb();
      await canvas.navigate({ url: "https://canvas.eliza.how/view" });
      const originalFrame = document.querySelector("iframe");

      await expect(canvas.navigate({ url })).rejects.toThrow(
        "Web view URL must use an allowed navigation scheme",
      );

      expect(document.querySelector("iframe")).toBe(originalFrame);
    },
  );
});
