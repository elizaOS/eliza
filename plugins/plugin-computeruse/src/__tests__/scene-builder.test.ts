/**
 * Scene-builder pipeline tests with fully synthetic deps.
 *
 * Asserts:
 *   - JSON shape (typed Scene matches contract for WS7)
 *   - Stable OCR id tagging across ticks
 *   - dHash short-circuit: unchanged frames reuse cached OCR
 *   - onAgentTurn always runs full pipeline (OCR+AX+apps refresh)
 *   - Subscribers are notified once per tick
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { DisplayCapture } from "../platform/capture.js";
import type { AccessibilityProvider } from "../scene/a11y-provider.js";
import { SceneBuilder, type SceneUpdateEvent } from "../scene/scene-builder.js";
import type {
  SceneApp,
  SceneAxNode,
  SceneOcrBox,
} from "../scene/scene-types.js";
import type { DisplayDescriptor } from "../types.js";

// ── tiny PNG builder, shared with dhash test ────────────────────────────────

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc ^ bytes[i]!) >>> 0;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(seed: number): Buffer {
  const w = 16;
  const h = 16;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = ((x + seed * 4) * 16) % 255;
      rows.push(v, v, v);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── fakes ───────────────────────────────────────────────────────────────────

const fakeDisplays: DisplayDescriptor[] = [
  {
    id: 0,
    bounds: [0, 0, 1920, 1080],
    scaleFactor: 1,
    primary: true,
    name: "fake-1",
  },
];

function makeFakeAxProvider(nodes: SceneAxNode[]): AccessibilityProvider {
  return {
    name: "fake",
    available: () => true,
    snapshot: async () => nodes,
  };
}

function makeFakeOcr(perFrame: SceneOcrBox[][]): {
  fn: (
    png: Buffer,
    displayId: number,
    idState: { perDisplay: Map<number, number> },
  ) => Promise<SceneOcrBox[]>;
  callCount: () => number;
} {
  let i = 0;
  let calls = 0;
  return {
    fn: async (_png, displayId, idState) => {
      calls += 1;
      const slice = perFrame[Math.min(i, perFrame.length - 1)] ?? [];
      i += 1;
      // Stamp fresh ids via the provided id state so we exercise the
      // builder's per-display sequence assignment.
      return slice.map((box) => {
        const seq = (idState.perDisplay.get(displayId) ?? 0) + 1;
        idState.perDisplay.set(displayId, seq);
        return { ...box, id: `t${displayId}-${seq}`, displayId };
      });
    },
    callCount: () => calls,
  };
}

function makeBuilder(
  options: {
    captures?: DisplayCapture[][];
    apps?: SceneApp[];
    ax?: SceneAxNode[];
    ocrBoxesPerCall?: SceneOcrBox[][];
  } = {},
): { builder: SceneBuilder; ocrCalls: () => number } {
  const captures = options.captures ?? [
    [
      {
        display: {
          id: 0,
          bounds: [0, 0, 1920, 1080],
          scaleFactor: 1,
          primary: true,
          name: "fake-1",
        },
        frame: makePng(1),
      },
    ],
  ];
  let i = 0;
  const ocr = makeFakeOcr(options.ocrBoxesPerCall ?? [[]]);
  const builder = new SceneBuilder({
    captureAll: async () =>
      captures[Math.min(i++, captures.length - 1)] ??
      captures[captures.length - 1]!,
    captureOne: async () => captures[0]![0]!,
    listDisplays: () => fakeDisplays,
    enumerateApps: () => options.apps ?? [],
    accessibilityProvider: makeFakeAxProvider(options.ax ?? []),
    runOcrOnFrame: ocr.fn,
    log: () => {},
  });
  return { builder, ocrCalls: ocr.callCount };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("SceneBuilder — JSON shape", () => {
  it("produces a fully-typed Scene", async () => {
    const { builder } = makeBuilder({
      apps: [
        {
          name: "Firefox",
          pid: 1234,
          windows: [
            {
              id: "w1",
              title: "GitHub",
              bounds: [0, 0, 800, 600],
              displayId: 0,
            },
          ],
        },
      ],
      ax: [
        {
          id: "a0-1",
          role: "window",
          label: "GitHub",
          bbox: [0, 0, 800, 600],
          actions: ["focus"],
          displayId: 0,
        },
      ],
      ocrBoxesPerCall: [
        [
          {
            id: "placeholder",
            text: "Hello world",
            bbox: [10, 20, 100, 24],
            conf: 0.92,
            displayId: 0,
          },
        ],
      ],
    });
    const scene = await builder.tick("active");
    expect(scene.timestamp).toBeGreaterThan(0);
    expect(scene.displays).toHaveLength(1);
    expect(scene.displays[0]?.id).toBe(0);
    expect(scene.apps).toHaveLength(1);
    expect(scene.apps[0]?.windows[0]?.title).toBe("GitHub");
    expect(scene.ax).toHaveLength(1);
    expect(scene.ax[0]?.id).toBe("a0-1");
    expect(scene.ocr).toHaveLength(1);
    // id was rewritten by the fake OCR adapter to t<display>-<seq>.
    expect(scene.ocr[0]?.id).toBe("t0-1");
    expect(scene.focused_window?.app).toBe("Firefox");
    expect(scene.vlm_scene).toBeNull();
    expect(scene.vlm_elements).toBeNull();
  });
});

describe("SceneBuilder — dHash short-circuit", () => {
  it("reuses cached OCR when the frame dHash is unchanged", async () => {
    // Both captures return the same PNG bytes -> identical dHash.
    const samePng = makePng(7);
    const cap: DisplayCapture[] = [
      {
        display: {
          id: 0,
          bounds: [0, 0, 1920, 1080],
          scaleFactor: 1,
          primary: true,
          name: "fake-1",
        },
        frame: samePng,
      },
    ];
    const { builder, ocrCalls } = makeBuilder({
      captures: [cap, cap, cap],
      ocrBoxesPerCall: [
        [
          {
            id: "x",
            text: "frame1",
            bbox: [0, 0, 10, 10],
            conf: 0.5,
            displayId: 0,
          },
        ],
      ],
    });
    await builder.tick("active");
    // Wait long enough that the idle-gate (2s) would skip OCR on the
    // next tick, but instead we rely on the dHash short-circuit
    // because the frame is identical.
    const second = await builder.tick("active");
    expect(ocrCalls()).toBe(1);
    // Cached OCR is replayed.
    expect(second.ocr).toHaveLength(1);
    expect(second.ocr[0]?.text).toBe("frame1");
  });

  it("re-runs OCR when the frame dHash changes", async () => {
    const cap1: DisplayCapture[] = [
      {
        display: {
          id: 0,
          bounds: [0, 0, 1920, 1080],
          scaleFactor: 1,
          primary: true,
          name: "fake-1",
        },
        frame: makePng(1),
      },
    ];
    const cap2: DisplayCapture[] = [
      {
        display: {
          id: 0,
          bounds: [0, 0, 1920, 1080],
          scaleFactor: 1,
          primary: true,
          name: "fake-1",
        },
        frame: makePng(200),
      },
    ];
    const { builder, ocrCalls } = makeBuilder({
      captures: [cap1, cap2],
      ocrBoxesPerCall: [
        [
          {
            id: "a",
            text: "first",
            bbox: [0, 0, 10, 10],
            conf: 0.5,
            displayId: 0,
          },
        ],
        [
          {
            id: "b",
            text: "second",
            bbox: [0, 0, 10, 10],
            conf: 0.5,
            displayId: 0,
          },
        ],
      ],
    });
    await builder.tick("active");
    const second = await builder.tick("active");
    expect(ocrCalls()).toBe(2);
    expect(second.ocr[0]?.text).toBe("second");
  });
});

describe("SceneBuilder — subscribers + onAgentTurn", () => {
  it("notifies subscribers once per tick with the produced Scene", async () => {
    const { builder } = makeBuilder({});
    const events: SceneUpdateEvent[] = [];
    const unsub = builder.subscribe((e) => events.push(e));
    await builder.tick("active");
    await builder.onAgentTurn();
    unsub();
    expect(events).toHaveLength(2);
    expect(events[0]?.reason).toBe("active");
    expect(events[1]?.reason).toBe("agent-turn");
  });

  it("onAgentTurn forces a full-pipeline build even if dHash is unchanged", async () => {
    const samePng = makePng(11);
    const cap: DisplayCapture[] = [
      {
        display: {
          id: 0,
          bounds: [0, 0, 1920, 1080],
          scaleFactor: 1,
          primary: true,
          name: "fake-1",
        },
        frame: samePng,
      },
    ];
    const { builder, ocrCalls } = makeBuilder({
      captures: [cap, cap],
    });
    await builder.tick("active");
    await builder.onAgentTurn();
    // Agent-turn forces OCR even if frame is unchanged.
    expect(ocrCalls()).toBe(2);
  });
});

describe("SceneBuilder — display-local coords", () => {
  it("OCR bboxes are display-local (not OS-global)", async () => {
    const { builder } = makeBuilder({
      ocrBoxesPerCall: [
        [
          {
            id: "x",
            text: "Hello",
            bbox: [10, 20, 50, 24],
            conf: 0.9,
            displayId: 0,
          },
        ],
      ],
    });
    const scene = await builder.tick("active");
    expect(scene.ocr[0]?.bbox).toEqual([10, 20, 50, 24]);
    expect(scene.ocr[0]?.displayId).toBe(0);
  });

  it("AX bboxes carry displayId so coords.ts translation works", async () => {
    const { builder } = makeBuilder({
      ax: [
        {
          id: "a0-1",
          role: "button",
          label: "Submit",
          bbox: [100, 50, 80, 30],
          actions: ["press"],
          displayId: 0,
        },
      ],
    });
    const scene = await builder.tick("active");
    expect(scene.ax[0]?.displayId).toBe(0);
    expect(scene.ax[0]?.bbox).toEqual([100, 50, 80, 30]);
  });
});
