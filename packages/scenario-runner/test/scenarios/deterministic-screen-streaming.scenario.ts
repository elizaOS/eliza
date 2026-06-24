/**
 * Deterministic e2e for continuous low-token screen streaming (issue #9105 §9,
 * M3 — `deterministic-screen-streaming`).
 *
 * Feeds N identical-dHash frames through the Brain's call-site dHash describe
 * cache and asserts the dominant CUA-loop cost — the (possibly remote)
 * IMAGE_DESCRIPTION call — is paid exactly once: the remaining N-1 frames are
 * served from cache. `Brain.getStats()` is the token counter that proves the
 * saving (`invocations:1, cacheHits:N-1`).
 *
 * No live model, no real capture: the Brain is driven with a spy `invokeModel`
 * and real synthesized PNGs so `frameDhash()` is meaningful.
 */

import { deflateSync } from "node:zlib";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { Brain } from "../../../../plugins/plugin-computeruse/src/actor/brain.ts";
import type { DisplayCapture } from "../../../../plugins/plugin-computeruse/src/platform/capture.ts";
import type { Scene } from "../../../../plugins/plugin-computeruse/src/scene/scene-types.ts";

const FRAME_COUNT = 10;

// ── minimal valid PNG synthesizer (16x16 RGB) ───────────────────────────────
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
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

/** Synthesize a 16x16 RGB PNG. Same `seed` → identical pixels → identical dHash. */
function makeTinyPng(seed = 0): Buffer {
  const w = 16;
  const h = 16;
  const rows: number[] = [];
  for (let y = 0; y < h; y += 1) {
    rows.push(0);
    for (let x = 0; x < w; x += 1) {
      const v = ((x + seed) * 16) % 255;
      rows.push(v, v, v);
    }
  }
  const idat = deflateSync(Buffer.from(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function dummyScene(): Scene {
  return {
    timestamp: 1,
    displays: [
      {
        id: 0,
        bounds: [0, 0, 16, 16],
        scaleFactor: 1,
        primary: true,
        name: "f",
      },
    ],
    focused_window: null,
    apps: [],
    ocr: [],
    ax: [],
    vlm_scene: null,
    vlm_elements: null,
  };
}

function captures(frame: Buffer): Map<number, DisplayCapture> {
  const m = new Map<number, DisplayCapture>();
  m.set(0, {
    display: {
      id: 0,
      bounds: [0, 0, 16, 16],
      scaleFactor: 1,
      primary: true,
      name: "f",
    },
    frame,
  });
  return m;
}

const VALID_BRAIN_OUTPUT = JSON.stringify({
  scene_summary: "OK",
  target_display_id: 0,
  roi: [],
  proposed_action: { kind: "click", ref: "t0-1", rationale: "Save" },
});

interface StreamingResult {
  describeCalls: number;
  invocations: number;
  cacheHits: number;
}

let lastRun: StreamingResult | null = null;

async function runScreenStreaming(): Promise<string | undefined> {
  let describeCalls = 0;
  const brain = new Brain(null, {
    invokeModel: async () => {
      describeCalls += 1;
      return VALID_BRAIN_OUTPUT;
    },
  });

  const goal = "click save";
  let first: unknown = null;
  for (let i = 0; i < FRAME_COUNT; i += 1) {
    // Same pixels each tick → identical dHash → cache hit after the first.
    const out = await brain.observeAndPlan({
      scene: dummyScene(),
      goal,
      captures: captures(makeTinyPng(0)),
    });
    if (i === 0) {
      first = out;
    } else if (JSON.stringify(out) !== JSON.stringify(first)) {
      return `frame ${i} returned a different plan than the cached first frame`;
    }
  }

  const stats = brain.getStats();
  lastRun = {
    describeCalls,
    invocations: stats.invocations,
    cacheHits: stats.cacheHits,
  };

  if (describeCalls !== 1) {
    return `expected exactly 1 remote describe call across ${FRAME_COUNT} identical frames, saw ${describeCalls}`;
  }
  if (stats.invocations !== 1) {
    return `expected getStats().invocations === 1, saw ${stats.invocations}`;
  }
  if (stats.cacheHits !== FRAME_COUNT - 1) {
    return `expected getStats().cacheHits === ${FRAME_COUNT - 1}, saw ${stats.cacheHits}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-screen-streaming",
  lane: "pr-deterministic",
  title: "Continuous screen streaming dedups identical frames (1 remote call)",
  domain: "computeruse",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "computeruse",
    "vision",
    "streaming",
  ],
  isolation: "shared-runtime",
  seed: [
    {
      type: "custom",
      name: "stream N identical frames through the Brain dHash cache",
      apply: runScreenStreaming,
    },
  ],
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "describe ran once; the token counter proves the per-frame saving",
      predicate: (_ctx: ScenarioContext) => {
        if (!lastRun) return "Brain streaming loop did not run";
        if (lastRun.describeCalls !== 1) {
          return `describeCalls=${lastRun.describeCalls}, expected 1`;
        }
        if (lastRun.invocations !== 1) {
          return `invocations=${lastRun.invocations}, expected 1`;
        }
        if (lastRun.cacheHits !== FRAME_COUNT - 1) {
          return `cacheHits=${lastRun.cacheHits}, expected ${FRAME_COUNT - 1}`;
        }
        return undefined;
      },
    },
  ],
});
