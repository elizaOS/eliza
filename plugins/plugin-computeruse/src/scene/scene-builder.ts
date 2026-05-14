/**
 * WS6 — Scene Builder
 *
 * Produces a single compact `Scene` JSON object per scene update. The runtime
 * lifecycle is:
 *
 *   1. Idle poll @ 1 Hz       — capture each display, compute frame dHash.
 *                                If no change observed for >2s, skip OCR + AX.
 *   2. Active poll @ 4 Hz     — capture, dHash, block-grid diff, run OCR on
 *                                the dirty blocks only, fold in AX snapshot.
 *   3. Agent turn (onAgentTurn) — full pipeline including the WS7 VLM hook.
 *                                 We surface a clean entry point but do NOT
 *                                 call the VLM here.
 *
 * Caches:
 *   - Whole-display scene cache keyed by `(displayId, frameDhash)`, TTL 30s.
 *   - Per-display previous BlockGrid kept in memory; dirtied on every active
 *     frame.
 *   - AX subtree cache: we re-snapshot every agent turn and every active
 *     poll when no AX focus-change notifications are available (which is
 *     the case on every desktop OS today). The AT-SPI signal route would
 *     remove that polling — call out as a follow-up.
 *
 * The builder is dependency-injectable for tests: pass an in-memory
 * `captureDisplays`, `enumerateApps`, `accessibilityProvider`, and OCR adapter
 * to assert pipeline behavior without a real screen.
 */

import { EventEmitter } from "node:events";
import { findDisplay, listDisplays } from "../platform/displays.js";
import { captureAllDisplays, captureDisplay, captureDisplayRegion } from "../platform/capture.js";
import type { DisplayCapture } from "../platform/capture.js";
import type { DisplayDescriptor } from "../types.js";
import {
  type AccessibilityProvider,
  resolveAccessibilityProvider,
} from "./a11y-provider.js";
import { enumerateApps } from "./apps.js";
import {
  type BlockGrid,
  blockGrid,
  coalesceDirtyBlocks,
  diffBlocks,
  frameDhash,
  hamming,
  pngDimensions,
} from "./dhash.js";
import {
  type OcrAdapterIdState,
  makeOcrIdState,
  runOcrOnPng,
  runOcrOnRegions,
  setOcrLoggingHook,
} from "./ocr-adapter.js";
import type {
  Scene,
  SceneApp,
  SceneAxNode,
  SceneFocusedWindow,
  SceneOcrBox,
} from "./scene-types.js";

const IDLE_THRESHOLD_MS = 2000;
const CACHE_TTL_MS = 30_000;
const FRAME_HAMMING_THRESHOLD = 5;

export interface SceneBuilderDeps {
  captureAll?: () => Promise<DisplayCapture[]>;
  captureOne?: (displayId: number) => Promise<DisplayCapture>;
  /**
   * Capture a region within a display in display-local coordinates. Used by
   * the dirty-block re-OCR fast path to avoid full-frame OCR when only a
   * small slice of the screen changed. Default: `captureDisplayRegion`.
   */
  captureRegion?: (
    displayId: number,
    region: { x: number; y: number; width: number; height: number },
  ) => Promise<DisplayCapture>;
  enumerateApps?: () => SceneApp[];
  listDisplays?: () => DisplayDescriptor[];
  accessibilityProvider?: AccessibilityProvider;
  runOcrOnFrame?: (
    png: Buffer,
    displayId: number,
    idState: OcrAdapterIdState,
  ) => Promise<SceneOcrBox[]>;
  /**
   * Run OCR on a list of cropped PNGs, each carrying its display-local bbox.
   * Returned boxes have their bboxes translated back into source-frame
   * display-local coordinates. Default: `runOcrOnRegions`.
   */
  runOcrOnCrops?: (
    crops: Array<{ png: Buffer; bbox: [number, number, number, number] }>,
    displayId: number,
    idState: OcrAdapterIdState,
  ) => Promise<SceneOcrBox[]>;
  log?: (msg: string) => void;
}

interface PerDisplayState {
  lastDhash: bigint | null;
  lastChangeAt: number;
  lastBlockGrid: BlockGrid | null;
  lastScene: { scene: Partial<Scene>; cachedAt: number; dhash: bigint | null };
}

export interface SceneUpdateEvent {
  scene: Scene;
  reason: "idle" | "active" | "agent-turn";
}

export class SceneBuilder extends EventEmitter {
  private readonly deps: Required<Omit<SceneBuilderDeps, "log">> & {
    log: (msg: string) => void;
  };
  private readonly perDisplay = new Map<number, PerDisplayState>();
  private readonly ocrIdState: OcrAdapterIdState = makeOcrIdState();
  private latestScene: Scene | null = null;
  private inFlight: Promise<Scene> | null = null;

  constructor(deps: SceneBuilderDeps = {}) {
    super();
    const log = deps.log ?? (() => {});
    this.deps = {
      captureAll: deps.captureAll ?? captureAllDisplays,
      captureOne: deps.captureOne ?? captureDisplay,
      enumerateApps: deps.enumerateApps ?? (() => enumerateApps()),
      listDisplays:
        deps.listDisplays ??
        (() =>
          listDisplays().map((d) => ({
            id: d.id,
            bounds: d.bounds,
            scaleFactor: d.scaleFactor,
            primary: d.primary,
            name: d.name,
          }))),
      accessibilityProvider:
        deps.accessibilityProvider ?? resolveAccessibilityProvider(),
      captureRegion:
        deps.captureRegion ??
        ((displayId, region) => captureDisplayRegion(displayId, region)),
      runOcrOnFrame:
        deps.runOcrOnFrame ??
        ((png, displayId, idState) => runOcrOnPng(png, displayId, idState)),
      runOcrOnCrops:
        deps.runOcrOnCrops ??
        ((crops, displayId, idState) =>
          runOcrOnRegions(crops, displayId, idState)),
      log,
    };
    setOcrLoggingHook(log);
  }

  /**
   * Pulse the pipeline. Mode chooses how much work to do:
   *   - "idle"     — capture + dHash only; reuses cached OCR/AX if unchanged.
   *   - "active"   — capture + dHash + dirty-block OCR + AX.
   *   - "agent-turn" — full pipeline; WS7's `onAgentTurn` should call this.
   *
   * Returns the produced Scene. Subscribers are notified after.
   */
  async tick(mode: "idle" | "active" | "agent-turn" = "active"): Promise<Scene> {
    if (this.inFlight) return this.inFlight;
    const promise = this.run(mode);
    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      this.inFlight = null;
    }
  }

  /** Called by WS7 when a real agent turn starts. Always full pipeline. */
  async onAgentTurn(): Promise<Scene> {
    return this.tick("agent-turn");
  }

  /** Returns the most recently emitted Scene, or null before first tick. */
  getCurrentScene(): Scene | null {
    return this.latestScene;
  }

  /** Subscribe to scene updates. Returns an unsubscribe function. */
  subscribe(handler: (event: SceneUpdateEvent) => void): () => void {
    const listener = (event: SceneUpdateEvent): void => handler(event);
    this.on("scene", listener);
    return () => this.off("scene", listener);
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private async run(mode: "idle" | "active" | "agent-turn"): Promise<Scene> {
    const t0 = Date.now();
    const displays = this.deps.listDisplays();
    const captures = await this.captureWithFallback(displays);

    const ocr: SceneOcrBox[] = [];
    for (const capture of captures) {
      const displayId = capture.display.id;
      const state = this.ensureState(displayId);
      const dHash = frameDhash(capture.frame);
      const changed =
        state.lastDhash === null ||
        dHash === null ||
        hamming(state.lastDhash, dHash) >= FRAME_HAMMING_THRESHOLD;
      if (changed) {
        state.lastChangeAt = t0;
      }
      // Agent turns ALWAYS re-OCR — the planner has to see fresh text even
      // if the screen looks pixel-identical (e.g. blinking cursor in a
      // text box that just received an enter key).
      const wholeFrameMatch =
        mode !== "agent-turn" &&
        !changed &&
        state.lastScene.dhash !== null &&
        dHash !== null &&
        hamming(state.lastScene.dhash, dHash) < FRAME_HAMMING_THRESHOLD &&
        t0 - state.lastScene.cachedAt < CACHE_TTL_MS;

      const idleNow = t0 - state.lastChangeAt > IDLE_THRESHOLD_MS;
      const wantOcr = mode === "agent-turn" || (mode === "active" && !idleNow);

      // Compute block-grid diff up-front so the dirty-block fast path can
      // fire even when the whole-frame dHash is unchanged. A single text
      // field flipping characters typically does not shift the resampled
      // 8×8 frame dHash but does flip one or two 16×16 blocks.
      const grid = wantOcr ? blockGrid(capture.frame) : null;
      const dims = wantOcr ? pngDimensions(capture.frame) : null;
      const dirty =
        wantOcr && grid && state.lastBlockGrid && dims
          ? diffBlocks(state.lastBlockGrid, grid, dims.width, dims.height)
          : null;
      const totalBlocks = grid ? grid.cols * grid.rows : 0;
      const dirtyFraction =
        dirty && totalBlocks > 0 ? dirty.length / totalBlocks : 1;
      const prevOcr = state.lastScene.scene.ocr ?? [];

      // 1. Whole-frame match + zero dirty blocks → cache hit.
      if (
        wholeFrameMatch &&
        state.lastScene.scene.ocr &&
        dirty !== null &&
        dirty.length === 0
      ) {
        const cached = state.lastScene.scene.ocr.filter((b) => b.displayId === displayId);
        ocr.push(...cached);
      } else if (wantOcr) {
        // 2. Dirty-block fast path: only re-capture + re-OCR the changed
        //    rectangles. We coalesce adjacent dirty blocks so a single
        //    changed text field is one OS region capture, not a dozen.
        if (
          dirty &&
          grid &&
          dims &&
          dirtyFraction > 0 &&
          dirtyFraction < 0.5 &&
          prevOcr.length > 0
        ) {
          const rects = coalesceDirtyBlocks(dirty, grid, dims.width, dims.height);
          const crops: Array<{
            png: Buffer;
            bbox: [number, number, number, number];
          }> = [];
          for (const rect of rects) {
            try {
              const regionCapture = await this.deps.captureRegion(displayId, {
                x: rect.bbox[0],
                y: rect.bbox[1],
                width: rect.bbox[2],
                height: rect.bbox[3],
              });
              crops.push({ png: regionCapture.frame, bbox: rect.bbox });
            } catch (err) {
              this.deps.log(
                `[scene-builder] captureRegion(${displayId}, ${rect.bbox.join(",")}) failed: ${
                  err instanceof Error ? err.message : String(err)
                } — falling back to full-frame OCR for this display`,
              );
              crops.length = 0;
              break;
            }
          }
          if (crops.length > 0) {
            const refreshed = await this.deps.runOcrOnCrops(
              crops,
              displayId,
              this.ocrIdState,
            );
            // Drop previous OCR boxes that intersect any dirty rect; keep the rest.
            const keep = prevOcr.filter(
              (b) => b.displayId === displayId && !intersectsAnyRect(b.bbox, rects),
            );
            ocr.push(...keep, ...refreshed);
          } else {
            const refreshed = await this.deps.runOcrOnFrame(
              capture.frame,
              displayId,
              this.ocrIdState,
            );
            ocr.push(...refreshed);
          }
        } else {
          // 3. Full-frame OCR (no usable dirty diff, or too many blocks dirty).
          const refreshed = await this.deps.runOcrOnFrame(
            capture.frame,
            displayId,
            this.ocrIdState,
          );
          ocr.push(...refreshed);
        }
        state.lastBlockGrid = grid ?? state.lastBlockGrid;
      } else if (state.lastScene.scene.ocr) {
        ocr.push(
          ...state.lastScene.scene.ocr.filter(
            (b) => b.displayId === displayId,
          ),
        );
      }

      state.lastDhash = dHash;
    }

    // Always refresh apps + AX on active and agent-turn modes. On pure idle
    // ticks we reuse the previously-built lists.
    let apps: SceneApp[];
    let ax: SceneAxNode[];
    if (mode === "idle" && this.latestScene) {
      apps = this.latestScene.apps;
      ax = this.latestScene.ax;
    } else {
      apps = this.safeEnumerateApps();
      ax = await this.safeSnapshotAx();
    }

    const focused = inferFocusedWindow(apps, ax, displays);
    const scene: Scene = {
      timestamp: t0,
      displays,
      focused_window: focused,
      apps,
      ocr,
      ax,
      vlm_scene: this.latestScene?.vlm_scene ?? null,
      vlm_elements: this.latestScene?.vlm_elements ?? null,
    };

    // Update caches.
    for (const cap of captures) {
      const state = this.ensureState(cap.display.id);
      state.lastScene = {
        scene: {
          ocr: scene.ocr,
          ax: scene.ax,
          apps: scene.apps,
        },
        cachedAt: t0,
        dhash: state.lastDhash,
      };
    }

    this.latestScene = scene;
    const reason: SceneUpdateEvent["reason"] = mode;
    this.emit("scene", { scene, reason });
    return scene;
  }

  private async captureWithFallback(
    displays: DisplayDescriptor[],
  ): Promise<DisplayCapture[]> {
    try {
      return await this.deps.captureAll();
    } catch (err) {
      this.deps.log(
        `[scene-builder] captureAllDisplays failed: ${err instanceof Error ? err.message : String(err)} — falling back to per-display capture`,
      );
    }
    const out: DisplayCapture[] = [];
    for (const d of displays) {
      try {
        out.push(await this.deps.captureOne(d.id));
      } catch (err) {
        this.deps.log(
          `[scene-builder] captureDisplay(${d.id}) failed: ${err instanceof Error ? err.message : String(err)} — display will be missing from scene`,
        );
      }
    }
    return out;
  }

  private safeEnumerateApps(): SceneApp[] {
    try {
      return this.deps.enumerateApps();
    } catch (err) {
      this.deps.log(
        `[scene-builder] enumerateApps failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private async safeSnapshotAx(): Promise<SceneAxNode[]> {
    try {
      return await this.deps.accessibilityProvider.snapshot();
    } catch (err) {
      this.deps.log(
        `[scene-builder] accessibilityProvider.snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  private ensureState(displayId: number): PerDisplayState {
    let state = this.perDisplay.get(displayId);
    if (!state) {
      state = {
        lastDhash: null,
        lastChangeAt: 0,
        lastBlockGrid: null,
        lastScene: { scene: {}, cachedAt: 0, dhash: null },
      };
      this.perDisplay.set(displayId, state);
    }
    return state;
  }
}

function inferFocusedWindow(
  apps: SceneApp[],
  ax: SceneAxNode[],
  displays: DisplayDescriptor[],
): SceneFocusedWindow | null {
  // Heuristic: prefer the AX node that overlaps the largest display area —
  // typically the foreground window. This avoids platform-specific focus
  // queries while still producing a usable hint for WS7.
  let bestAx: SceneAxNode | null = null;
  let bestArea = 0;
  for (const node of ax) {
    const area = (node.bbox[2] ?? 0) * (node.bbox[3] ?? 0);
    if (area > bestArea) {
      bestArea = area;
      bestAx = node;
    }
  }
  if (!bestAx) return null;
  // Resolve display.
  const display = displays.find((d) => d.id === bestAx?.displayId) ?? displays[0];
  if (!display) return null;
  // Try to find a matching app via title contains.
  const lcLabel = (bestAx.label ?? "").toLowerCase();
  let app: SceneApp | undefined;
  for (const a of apps) {
    if (a.windows.some((w) => w.title.toLowerCase() === lcLabel)) {
      app = a;
      break;
    }
  }
  return {
    app: app?.name ?? bestAx.label ?? "unknown",
    pid: app?.pid ?? null,
    bounds: bestAx.bbox,
    title: bestAx.label ?? "",
    displayId: display.id,
  };
}

let singleton: SceneBuilder | null = null;
export function getDefaultSceneBuilder(): SceneBuilder {
  if (!singleton) singleton = new SceneBuilder();
  return singleton;
}

/** Test-only reset. */
export function _resetDefaultSceneBuilderForTests(): void {
  singleton = null;
}

function intersectsAnyRect(
  bbox: [number, number, number, number],
  rects: Array<{ bbox: [number, number, number, number] }>,
): boolean {
  const [bx, by, bw, bh] = bbox;
  for (const r of rects) {
    const [rx, ry, rw, rh] = r.bbox;
    const overlap = bx < rx + rw && bx + bw > rx && by < ry + rh && by + bh > ry;
    if (overlap) return true;
  }
  return false;
}
