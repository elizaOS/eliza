// @vitest-environment jsdom

/**
 * Exercises CanvasWeb validation, DOM/layer lifecycles, compositing calls and messaging boundaries.
 * Runs real plugin instances in jsdom with only the unavailable 2D rendering
 * context stubbed; browser-engine postMessage behavior is covered separately
 * by the review evidence harness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasWeb } from "./web";

function createContextStub(
  drawImage: CanvasRenderingContext2D["drawImage"] = vi.fn(),
): CanvasRenderingContext2D {
  return {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    drawImage,
    rect: vi.fn(),
    globalAlpha: 1,
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

describe("CanvasWeb attachment lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      createContextStub(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("composites a layer created before the base canvas is attached", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });
    const host = document.createElement("div");

    await canvas.attach({ canvasId, element: host });

    expect(host.querySelectorAll("canvas")).toHaveLength(2);
  });

  it("composites a layer created after the base canvas is attached", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    const host = document.createElement("div");
    await canvas.attach({ canvasId, element: host });

    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });

    expect(host.querySelectorAll("canvas")).toHaveLength(2);
  });

  it("removes the base canvas and every layer when detached", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    const host = document.createElement("div");
    await canvas.attach({ canvasId, element: host });
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });

    await canvas.detach({ canvasId });

    expect(host.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("reattaches the base canvas and retained layers into a new host", async () => {
    const canvas = new CanvasWeb();
    const { canvasId } = await canvas.create({
      size: { width: 10, height: 10 },
    });
    const firstHost = document.createElement("div");
    const secondHost = document.createElement("div");
    await canvas.attach({ canvasId, element: firstHost });
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });

    await canvas.detach({ canvasId });
    await canvas.attach({ canvasId, element: secondHost });

    expect(firstHost.querySelectorAll("canvas")).toHaveLength(0);
    expect(secondHost.querySelectorAll("canvas")).toHaveLength(2);
  });
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

function stubBoundingRect(): void {
  // jsdom returns a zero rect; supply a stable non-zero rect so the
  // width/height coordinate scaling in setupTouchHandlers stays finite.
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getBoundingClientRect",
  ).mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect);
}

function pressCanvas(host: HTMLElement): void {
  const canvasEl = host.querySelector("canvas");
  if (!canvasEl) throw new Error("Missing base canvas element");
  // A single logical press: down then up. Duplicate listeners multiply the
  // "start" emission, so counting "start" events isolates the leak.
  canvasEl.dispatchEvent(
    new MouseEvent("mousedown", {
      clientX: 10,
      clientY: 10,
      bubbles: true,
    }),
  );
  canvasEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

async function newAttachedCanvas(): Promise<{
  canvas: CanvasWeb;
  canvasId: string;
  host: HTMLElement;
  starts: () => number;
}> {
  const canvas = new CanvasWeb();
  const { canvasId } = await canvas.create({
    size: { width: 100, height: 100 },
  });
  const touchEvents: string[] = [];
  await canvas.addListener("touch", (event) => {
    touchEvents.push((event as { type: string }).type);
  });
  const host = document.createElement("div");
  await canvas.attach({ canvasId, element: host });
  await canvas.setTouchEnabled({ canvasId, enabled: true });
  return {
    canvas,
    canvasId,
    host,
    starts: () => touchEvents.filter((t) => t === "start").length,
  };
}

describe("CanvasWeb touch listener lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      createContextStub(),
    );
    stubBoundingRect();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("keeps one listener through initial attach and repeated detach/reattach", async () => {
    const { canvas, canvasId, host, starts } = await newAttachedCanvas();
    pressCanvas(host);
    expect(starts()).toBe(1);

    for (let index = 0; index < 5; index += 1) {
      await canvas.detach({ canvasId });
      const nextHost = document.createElement("div");
      await canvas.attach({ canvasId, element: nextHost });
      pressCanvas(nextHost);
      expect(starts()).toBe(index + 2);
    }
  });

  it("emits exactly one touch per press after a second attach() without detach()", async () => {
    const { canvas, canvasId, host, starts } = await newAttachedCanvas();

    // Re-attaching to the same host without an intervening detach must not
    // add a duplicate set of listeners to the same canvas element.
    await canvas.attach({ canvasId, element: host });

    pressCanvas(host);

    expect(starts()).toBe(1);
  });

  it("removes listeners on detach so the retained element no longer emits", async () => {
    const { canvas, canvasId, host, starts } = await newAttachedCanvas();
    const canvasEl = host.querySelector("canvas");
    if (!canvasEl) throw new Error("Missing base canvas element");

    await canvas.detach({ canvasId });
    // The element object is retained inside ManagedCanvas; dispatch directly at
    // it (it is out of the DOM but still holds any bound listeners).
    canvasEl.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 5, clientY: 5 }),
    );
    canvasEl.dispatchEvent(new MouseEvent("mouseup"));

    expect(starts()).toBe(0);
  });

  it("suppresses emission when touch is disabled via setTouchEnabled(false)", async () => {
    const { canvas, canvasId, host, starts } = await newAttachedCanvas();

    await canvas.setTouchEnabled({ canvasId, enabled: false });
    pressCanvas(host);

    expect(starts()).toBe(0);
  });

  it("suppresses emission after removeAllListeners()", async () => {
    const { canvas, host, starts } = await newAttachedCanvas();

    await canvas.removeAllListeners();
    pressCanvas(host);

    expect(starts()).toBe(0);
  });
});

const drawImageSources: HTMLCanvasElement[] = [];

function lastCanvas(host: HTMLElement): HTMLCanvasElement {
  const all = host.querySelectorAll("canvas");
  return all[all.length - 1] as HTMLCanvasElement;
}

describe("CanvasWeb.toImage composite contract", () => {
  beforeEach(() => {
    drawImageSources.length = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (() =>
        createContextStub(
          vi.fn((source: CanvasImageSource) => {
            drawImageSources.push(source as HTMLCanvasElement);
          }),
        )) as never,
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

  it("exports the base and visible layers in z-index order, excluding hidden layers", async () => {
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
      layer: { visible: false, opacity: 1, zIndex: 3 },
    });
    const { layerId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 0.5, zIndex: 1 },
    });
    const lowEl = lastCanvas(host);
    await canvas.drawRect({
      canvasId,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      fill: { color: "#ff0000" },
      drawOptions: { layerId },
    });

    drawImageSources.length = 0;
    const result = await canvas.toImage({ canvasId, format: "png" });

    expect(result.format).toBe("png");
    expect(drawImageSources).toEqual([baseEl, lowEl, highEl]);
  });

  it("restricts the export to the named layerIds subset and omits the base", async () => {
    const { canvas, canvasId, host } = await setup();
    const { layerId: firstId } = await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 0 },
    });
    const firstEl = lastCanvas(host);
    await canvas.createLayer({
      canvasId,
      layer: { visible: true, opacity: 1, zIndex: 1 },
    });

    drawImageSources.length = 0;
    await canvas.toImage({ canvasId, format: "png", layerIds: [firstId] });

    expect(drawImageSources).toEqual([firstEl]);
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
