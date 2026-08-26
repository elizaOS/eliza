// @vitest-environment jsdom

/**
 * Regression coverage for `CanvasWeb` touch/pointer listener lifecycle across
 * attach/detach cycles. Runs a real `CanvasWeb` instance in jsdom with only the
 * unavailable 2D context and `getBoundingClientRect` stubbed, then dispatches
 * real `MouseEvent`s at the base canvas to count emitted `touch` events. Guards
 * the contract that a detach->attach cycle (or a repeat attach() without an
 * intervening detach) never stacks duplicate listeners — matching the native
 * iOS (`touchesBegan`) and Android (view-intrinsic) bridges that bind once.
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

  it("emits exactly one touch per press after a single attach()", async () => {
    const { host, starts } = await newAttachedCanvas();

    pressCanvas(host);

    expect(starts()).toBe(1);
  });

  it("emits exactly one touch per press after a detach()->attach() cycle", async () => {
    const { canvas, canvasId, starts } = await newAttachedCanvas();

    await canvas.detach({ canvasId });
    const secondHost = document.createElement("div");
    await canvas.attach({ canvasId, element: secondHost });

    pressCanvas(secondHost);

    // Pre-fix: detach() removed the element but not its listeners, and the
    // re-attach bound a second set, so this press emitted 2 "start" events.
    expect(starts()).toBe(1);
  });

  it("does not stack listeners across many detach()->attach() cycles", async () => {
    const { canvas, canvasId, host, starts } = await newAttachedCanvas();

    let latestHost = host;
    for (let i = 0; i < 5; i++) {
      await canvas.detach({ canvasId });
      latestHost = document.createElement("div");
      await canvas.attach({ canvasId, element: latestHost });
    }

    pressCanvas(latestHost);

    expect(starts()).toBe(1);
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
