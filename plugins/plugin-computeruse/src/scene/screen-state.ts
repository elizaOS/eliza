/**
 * Unified `ScreenState` — one capture per turn (#9105 M3).
 *
 * Before this seam the same display was captured/encoded multiple times per
 * turn: the SceneBuilder's dHash gate, the SceneBuilder's OCR pass, and the
 * Brain's `encodeForBrain` each pulled their own frame. `ScreenStateStore`
 * makes the capture a single shared artifact: it grabs one PNG per display,
 * computes the frame dHash and the 16×16 block grid once, and hands every
 * consumer (OCR adapter, DirtyTileDescriber, scene provider, Brain) the same
 * `ScreenState`. Re-asking for a display within `freshnessMs` reuses the prior
 * capture instead of hitting the OS again.
 *
 * Change detection rides the existing `scene/dhash.ts`: a refresh only emits a
 * change event when the frame dHash moved by at least `hammingThreshold` bits,
 * so subscribers (e.g. the continuous describer loop) don't re-run on a
 * pixel-identical screen. `getStats()` exposes how many captures were served
 * from cache vs taken fresh so a test can prove the per-turn saving.
 *
 * Pure + injectable: pass a `capture` fn to drive the store from synthetic PNGs
 * with no real screen.
 */

import type { DisplayCapture } from "../platform/capture.js";
import {
  type BlockGrid,
  blockGrid,
  type DirtyBlock,
  diffBlocks,
  frameDhash,
  hamming,
  pngDimensions,
} from "./dhash.js";

/** Frame-dHash hamming distance below which two frames are "unchanged". */
export const SCREEN_STATE_HAMMING_THRESHOLD = 5;
/** Default reuse window: a capture younger than this is served from cache. */
export const SCREEN_STATE_DEFAULT_FRESHNESS_MS = 400;

/** A single shared per-display capture for one turn. */
export interface ScreenState {
  displayId: number;
  /** ms epoch when the underlying frame was captured. */
  capturedAt: number;
  width: number;
  height: number;
  /** PNG bytes at backing-store resolution. */
  png: Buffer;
  /** 64-bit frame dHash, or null when the PNG could not be decoded. */
  dhash: bigint | null;
  /** 16×16 block grid of the frame, or null when undecodable. */
  blockGrid: BlockGrid | null;
  /**
   * Blocks that changed vs the previously stored frame for this display.
   * `null` on the very first capture (no prior to diff against). Bboxes are in
   * display-local pixel space when dimensions were available.
   */
  dirtyBlocks: DirtyBlock[] | null;
}

export interface ScreenStateChange {
  state: ScreenState;
  /** dHash hamming distance from the previous frame (Infinity on first frame). */
  distance: number;
}

/** Capture-accounting snapshot for a store. */
export interface ScreenStateStats {
  /** Fresh OS captures actually taken. */
  captures: number;
  /** Capture requests served from the freshness cache (no OS hit). */
  cacheHits: number;
  /** Refreshes that changed the screen enough to fire a change event. */
  changes: number;
}

export interface ScreenStateStoreOptions {
  /**
   * Capture one display to a PNG. Defaults to the platform `captureDisplay`.
   * Injected in tests to drive synthetic frames.
   */
  capture: (displayId: number) => Promise<DisplayCapture>;
  /** Reuse window in ms. Default `SCREEN_STATE_DEFAULT_FRESHNESS_MS`. */
  freshnessMs?: number;
  /** Hamming threshold for "changed". Default `SCREEN_STATE_HAMMING_THRESHOLD`. */
  hammingThreshold?: number;
  /** Clock injection for deterministic freshness tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Owns the single shared capture per display. `ComputerUseService` holds one
 * store; SceneBuilder, the Brain, and the DirtyTileDescriber loop all read it.
 */
export class ScreenStateStore {
  private readonly capture: (displayId: number) => Promise<DisplayCapture>;
  private readonly freshnessMs: number;
  private readonly hammingThreshold: number;
  private readonly now: () => number;
  private readonly states = new Map<number, ScreenState>();
  private readonly listeners = new Set<(change: ScreenStateChange) => void>();
  private stats: ScreenStateStats = { captures: 0, cacheHits: 0, changes: 0 };

  constructor(options: ScreenStateStoreOptions) {
    this.capture = options.capture;
    this.freshnessMs = options.freshnessMs ?? SCREEN_STATE_DEFAULT_FRESHNESS_MS;
    this.hammingThreshold =
      options.hammingThreshold ?? SCREEN_STATE_HAMMING_THRESHOLD;
    this.now = options.now ?? Date.now;
  }

  getStats(): ScreenStateStats {
    return { ...this.stats };
  }

  /** Latest stored state for a display, or null if never captured. */
  peek(displayId: number): ScreenState | null {
    return this.states.get(displayId) ?? null;
  }

  /**
   * Return a `ScreenState` for `displayId`, reusing the last capture when it is
   * younger than the freshness window. Pass `force` to always re-capture.
   */
  async get(displayId: number, force = false): Promise<ScreenState> {
    const prior = this.states.get(displayId);
    if (!force && prior && this.now() - prior.capturedAt < this.freshnessMs) {
      this.stats.cacheHits += 1;
      return prior;
    }
    return this.refresh(displayId);
  }

  /**
   * Force a fresh capture, recompute dHash + block grid + dirty diff against the
   * prior frame, store it, and emit a change event when the frame moved by at
   * least the hamming threshold.
   */
  async refresh(displayId: number): Promise<ScreenState> {
    const prior = this.states.get(displayId);
    const captured = await this.capture(displayId);
    this.stats.captures += 1;
    const png = captured.frame;
    const dims = pngDimensions(png);
    const dhash = frameDhash(png);
    const grid = blockGrid(png);
    const dirtyBlocks =
      prior && grid
        ? diffBlocks(prior.blockGrid, grid, dims?.width, dims?.height)
        : null;
    const state: ScreenState = {
      displayId,
      capturedAt: this.now(),
      width: dims?.width ?? 0,
      height: dims?.height ?? 0,
      png,
      dhash,
      blockGrid: grid,
      dirtyBlocks,
    };
    this.states.set(displayId, state);

    const distance =
      prior && prior.dhash !== null && dhash !== null
        ? hamming(prior.dhash, dhash)
        : Number.POSITIVE_INFINITY;
    if (distance >= this.hammingThreshold) {
      this.stats.changes += 1;
      const change: ScreenStateChange = { state, distance };
      for (const listener of this.listeners) listener(change);
    }
    return state;
  }

  /** Subscribe to change events. Returns an unsubscribe function. */
  onChange(listener: (change: ScreenStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
