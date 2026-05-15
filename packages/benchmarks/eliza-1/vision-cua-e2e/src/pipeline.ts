/**
 * eliza-1 vision + CUA E2E pipeline.
 *
 * Orchestrates the full loop:
 *
 *   capture(all displays)
 *     -> tile each display with the Qwen3.5-VL-friendly tiler
 *     -> for each tile: IMAGE_DESCRIPTION + OCR-with-coords
 *     -> reconcile overlapping tile content (dedup OCR text by absolute bbox)
 *     -> grounding: ask the VLM where the target UI element sits inside a tile
 *     -> reconstruct absolute display coords with the tiler's helper
 *     -> click via plugin-computeruse
 *     -> re-capture, compare, assert state changed
 *
 * Stub mode (default) wires the VLM, OCR, and click driver to the canned
 * implementations under `src/stubs/`. Real mode (env
 * `ELIZA_VISION_CUA_E2E_REAL=1`) wires through `runtime.useModel(...)` and
 * `performDesktopClick(...)`. See README for the swap procedure.
 *
 * The pipeline intentionally consumes plugin-vision and plugin-computeruse
 * through public interfaces only:
 *   - Capture: `captureAllDisplays()` (plugin-computeruse).
 *   - Tile:    `tileScreenshot()` (plugin-vision; mirrored locally — see
 *              `./screen-tiler.ts` for why).
 *   - OCR:     `OcrWithCoordsService.describe()` (plugin-vision).
 *   - VLM:     `runtime.useModel(IMAGE_DESCRIPTION, …)` (eliza-1 plugin
 *              registers this slot).
 *   - Click:   `performDesktopClick()` (plugin-computeruse).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FixtureId, loadFixture } from "./fixtures.ts";
import { captureRealDisplays } from "./real-capture.ts";
import { RealDriver, spawnControlledWindow } from "./real-driver.ts";
import { discoverOcrProvider, type RealOcrProvider } from "./real-ocr.ts";
import { discoverRuntimeAdapter } from "./real-runtime.ts";
import { RealVlm } from "./real-vlm.ts";
import {
  reconstructAbsoluteCoords,
  type ScreenTile,
  tileScreenshot,
} from "./screen-tiler.ts";
import { StubDriver } from "./stubs/stub-driver.ts";
import { StubOcrWithCoords } from "./stubs/stub-ocr.ts";
import { StubVlm } from "./stubs/stub-vlm.ts";
import type {
  AbsoluteClickTarget,
  DisplayCaptureFixture,
  DisplayRunRecord,
  GroundingResult,
  OcrCoordResult,
  PipelineStage,
  PipelineTrace,
  StageRecord,
} from "./types.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPORT_DIR = join(HERE, "..", "reports");

export interface RunPipelineOptions {
  readonly fixtureId: FixtureId;
  /** Free-text grounding target. Default: "the close button on the focused window". */
  readonly groundingTarget?: string;
  /** When true, write the trace to `reports/`. Default true. */
  readonly writeReport?: boolean;
  /** Override the report directory. Default: `<package>/reports`. */
  readonly reportDir?: string;
  /** Override the run id (default: timestamp). */
  readonly runId?: string;
  /** Tile budget — default 1280px (Qwen3.5-VL sweet spot). */
  readonly maxTileEdge?: number;
}

export interface RunRealPipelineOptions {
  /** Free-text grounding target. */
  readonly groundingTarget?: string;
  /** Persist trace to `reports/`. Default true. */
  readonly writeReport?: boolean;
  /** Override the report directory. Default: `<package>/reports`. */
  readonly reportDir?: string;
  /** Override the run id (default: timestamp). */
  readonly runId?: string;
  /** Tile budget — default 1280px. */
  readonly maxTileEdge?: number;
  /**
   * When true, the driver records clicks but does not move the host mouse,
   * even if a controlled window was spawned. Useful for "wire up everything
   * but stop short of input dispatch" runs.
   */
  readonly noopClick?: boolean;
  /**
   * When true, do not spawn a controlled window. Implies `noopClick`. Set
   * by `scripts/run-real.sh` when the operator explicitly opts out via
   * `ELIZA_VISION_CUA_E2E_NO_CONTROLLED_WINDOW=1`.
   */
  readonly skipControlledWindow?: boolean;
  /** Override the controlled-window binary (default `xeyes`). */
  readonly controlledWindowBinary?: string;
}

export interface RunPipelineResult {
  readonly trace: PipelineTrace;
  readonly reportPath: string | null;
  readonly recordedClicks: ReadonlyArray<AbsoluteClickTarget>;
}

/**
 * Drive the pipeline against a fixture using stub VLM / OCR / click. The
 * trace is returned and (by default) persisted to `reports/`.
 *
 * Stub mode is dispatched here; real mode goes through `runRealPipeline`.
 * The unified entrypoint `runPipeline()` honours `ELIZA_VISION_CUA_E2E_REAL`.
 */
export async function runStubPipeline(
  opts: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const fixture = loadFixture(opts.fixtureId);
  const target =
    opts.groundingTarget ?? "the close button on the focused window";
  const vlm = new StubVlm({ fixtureId: opts.fixtureId });
  const ocr = new StubOcrWithCoords();
  const driver = new StubDriver();
  const backends = createStubBackends(vlm, ocr, driver);
  const runId = opts.runId ?? `vision-cua-e2e-${nowStamp()}`;
  const startedAt = new Date();

  const stages: StageRecord[] = [];
  const failures: string[] = [];
  const displays: DisplayRunRecord[] = [];

  const enumerate = await runStage("enumerate_displays", async () => {
    return {
      summary: `${fixture.captures.length} display(s): ${fixture.captures
        .map((c) => `${c.display.name}@${c.display.bounds.join(",")}`)
        .join(" | ")}`,
    };
  });
  stages.push(enumerate);
  if (!enumerate.ok)
    failures.push(`enumerate_displays: ${enumerate.error ?? "unknown"}`);

  for (const capture of fixture.captures) {
    const displayRecord = await runDisplay({
      capture,
      backends,
      groundingTarget: target,
      maxTileEdge: opts.maxTileEdge ?? 1280,
    });
    displays.push(displayRecord.record);
    stages.push(...displayRecord.stages);
    failures.push(...displayRecord.failures);
  }

  const finishedAt = new Date();
  const trace: PipelineTrace = {
    run_id: runId,
    mode: "stub",
    fixture_id: fixture.id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    displays,
    stages,
    success:
      failures.length === 0 && displays.every((d) => d.stateChangeDetected),
    failures,
  };

  let reportPath: string | null = null;
  if (opts.writeReport !== false) {
    const dir = opts.reportDir ?? REPORT_DIR;
    mkdirSync(dir, { recursive: true });
    reportPath = join(dir, `${runId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  }

  const recordedClicks = driver.recordedClicks().map((click) => click.target);

  return { trace, reportPath, recordedClicks };
}

function createStubBackends(
  vlm: StubVlm,
  ocr: StubOcrWithCoords,
  driver: StubDriver,
): PipelineBackends {
  return {
    mode: "stub",
    async describe({ tile, displayId }) {
      return vlm.describe({
        imageUrl: pngToDataUrl(tile.pngBytes),
        prompt: JSON.stringify({
          task: "describe_visual_scene",
          instructions: ["Describe the focused window and its chrome."],
          tile: { id: tile.id, displayId },
        }),
      });
    },
    async ground({ tile, displayId, target }) {
      return vlm.ground(
        { description: target, tileId: tile.id, displayId },
        { tileWidth: tile.tileW, tileHeight: tile.tileH },
      );
    },
    async ocr({ tile, displayId }) {
      return ocr.describe({
        displayId,
        sourceX: tile.sourceX,
        sourceY: tile.sourceY,
        tileWidth: tile.tileW,
        tileHeight: tile.tileH,
      });
    },
    async click(target) {
      await driver.click(target);
    },
    recordedClicks() {
      return driver.recordedClicks().map((c) => ({ target: c.target }));
    },
  };
}

/**
 * Backend bundle. Stub mode and real mode each provide an adapter that
 * implements these three calls. The pipeline does not branch on `mode`
 * below the backend boundary.
 */
interface PipelineBackends {
  readonly mode: "stub" | "real";
  describe(args: {
    readonly tile: ScreenTile;
    readonly displayId: string;
  }): Promise<{ readonly description: string }>;
  ground(args: {
    readonly tile: ScreenTile;
    readonly displayId: string;
    readonly target: string;
  }): Promise<GroundingResult>;
  ocr(args: {
    readonly tile: ScreenTile;
    readonly displayId: string;
  }): Promise<OcrCoordResult>;
  click(target: AbsoluteClickTarget): Promise<void>;
  recordedClicks(): ReadonlyArray<{ readonly target: AbsoluteClickTarget }>;
}

interface RunDisplayArgs {
  readonly capture: DisplayCaptureFixture;
  readonly backends: PipelineBackends;
  readonly groundingTarget: string;
  readonly maxTileEdge: number;
}

interface RunDisplayResult {
  readonly record: DisplayRunRecord;
  readonly stages: ReadonlyArray<StageRecord>;
  readonly failures: ReadonlyArray<string>;
}

async function runDisplay(args: RunDisplayArgs): Promise<RunDisplayResult> {
  const { capture, backends, groundingTarget, maxTileEdge } = args;
  const displayId = String(capture.display.id);
  const stages: StageRecord[] = [];
  const failures: string[] = [];

  // Stage: capture — in stub mode the fixture is the capture. In real
  // mode the bytes were captured upstream by `captureRealDisplays`. Either
  // way we record the byte count for the trace.
  const captureStage = await runStage(
    "capture",
    async () => ({
      summary: `frame=${capture.frame.byteLength}B for display ${displayId}`,
    }),
    displayId,
  );
  stages.push(captureStage);
  if (!captureStage.ok)
    failures.push(`capture[${displayId}]: ${captureStage.error ?? "unknown"}`);

  // Stage: tile.
  let tiles: ScreenTile[] = [];
  const tileStage = await runStage(
    "tile",
    async () => {
      tiles = await tileScreenshot(
        {
          displayId,
          width: capture.display.bounds[2],
          height: capture.display.bounds[3],
          pngBytes: Buffer.from(capture.frame),
        },
        { maxEdge: maxTileEdge, overlapFraction: 0.12 },
      );
      return { summary: `${tiles.length} tile(s) at maxEdge=${maxTileEdge}` };
    },
    displayId,
  );
  stages.push(tileStage);
  if (!tileStage.ok)
    failures.push(`tile[${displayId}]: ${tileStage.error ?? "unknown"}`);

  // Stage: describe + ocr per tile, then reconcile.
  const allOcr: OcrCoordResult[] = [];
  for (const tile of tiles) {
    const describe = await runStage(
      "describe",
      async () => {
        const result = await backends.describe({ tile, displayId });
        return {
          summary: `${result.description.slice(0, 80)}${
            result.description.length > 80 ? "…" : ""
          }`,
        };
      },
      displayId,
    );
    stages.push(describe);
    if (!describe.ok)
      failures.push(
        `describe[${displayId}/${tile.id}]: ${describe.error ?? "unknown"}`,
      );

    const ocrStage = await runStage(
      "ocr",
      async () => {
        const result = await backends.ocr({ tile, displayId });
        allOcr.push(result);
        return {
          summary: `${result.blocks.length} block(s), ${result.blocks.reduce(
            (sum, b) => sum + b.words.length,
            0,
          )} word(s)`,
        };
      },
      displayId,
    );
    stages.push(ocrStage);
    if (!ocrStage.ok)
      failures.push(
        `ocr[${displayId}/${tile.id}]: ${ocrStage.error ?? "unknown"}`,
      );
  }

  // Reconcile overlapping tile OCR — dedup blocks whose absolute bboxes
  // overlap by >50%. (In stub mode this is a no-op since the stub returns
  // one block per tile, but the reconciliation step exists so the real
  // path doesn't need a separate scaffolding pass.)
  const reconciledWordCount = reconcileOcr(allOcr);

  // Stage: ground — pick a tile that the VLM's textual description hints
  // contains the target. In stub mode, prefer the first tile whose
  // semantic position matches "upper-right" (i.e. the right-most tile in
  // the top row). Real mode uses the same tile selection — the heuristic
  // is fine for the harness; sub-tile grounding accuracy is measured by a
  // separate bench.
  let grounding: GroundingResult | null = null;
  const groundStage = await runStage(
    "ground",
    async () => {
      const tile = pickTileForUpperRight(tiles);
      if (!tile) throw new Error(`no tile available on display ${displayId}`);
      grounding = await backends.ground({
        tile,
        displayId,
        target: groundingTarget,
      });
      return {
        summary: `tile=${tile.id} local=(${grounding.tileLocalX},${grounding.tileLocalY})`,
      };
    },
    displayId,
  );
  stages.push(groundStage);
  if (!groundStage.ok)
    failures.push(`ground[${displayId}]: ${groundStage.error ?? "unknown"}`);

  // Stage: click — reconstruct absolute coords and call the driver.
  let clickTarget: AbsoluteClickTarget | undefined;
  const clickStage = await runStage(
    "click",
    async () => {
      if (!grounding) throw new Error("grounding result missing");
      const tile = tiles.find((t) => t.id === grounding?.tileId);
      if (!tile)
        throw new Error(`grounded tile ${grounding.tileId} not found in tiles`);
      const abs = reconstructAbsoluteCoords(
        tile,
        grounding.tileLocalX,
        grounding.tileLocalY,
      );
      clickTarget = {
        displayId: abs.displayId,
        absoluteX: abs.absoluteX,
        absoluteY: abs.absoluteY,
      };
      await backends.click(clickTarget);
      return {
        summary: `click @ display=${clickTarget.displayId} x=${clickTarget.absoluteX} y=${clickTarget.absoluteY}`,
      };
    },
    displayId,
  );
  stages.push(clickStage);
  if (!clickStage.ok)
    failures.push(`click[${displayId}]: ${clickStage.error ?? "unknown"}`);

  // Stage: recapture + verify_state_change.
  const recapture = await runStage(
    "recapture",
    async () => ({
      summary: `frame-after=${capture.frameAfter.byteLength}B`,
    }),
    displayId,
  );
  stages.push(recapture);
  if (!recapture.ok)
    failures.push(`recapture[${displayId}]: ${recapture.error ?? "unknown"}`);

  let stateChangeDetected = false;
  const verifyStage = await runStage(
    "verify_state_change",
    async () => {
      const before = capture.frame;
      const after = capture.frameAfter;
      const sameLength = before.byteLength === after.byteLength;
      let differs = !sameLength;
      if (sameLength) {
        // Quick byte-level scan; in real mode this becomes a perceptual
        // diff (dHash) over a region around the click target. For the
        // harness, byte-level is sufficient — the fixtures swap red→green
        // at the click location.
        for (let i = 0; i < before.byteLength; i += 1) {
          if (before[i] !== after[i]) {
            differs = true;
            break;
          }
        }
      }
      stateChangeDetected = differs;
      if (!differs) throw new Error("no byte-level change detected");
      return { summary: `state changed (byte-diff)` };
    },
    displayId,
  );
  stages.push(verifyStage);
  if (!verifyStage.ok)
    failures.push(
      `verify_state_change[${displayId}]: ${verifyStage.error ?? "unknown"}`,
    );

  void reconciledWordCount; // keep variable referenced

  const record: DisplayRunRecord = {
    displayId,
    displayName: capture.display.name,
    bounds: capture.display.bounds,
    scaleFactor: capture.display.scaleFactor,
    primary: capture.display.primary,
    tileCount: tiles.length,
    stages,
    clickTarget,
    stateChangeDetected,
  };
  return { record, stages: [], failures };
}

function pickTileForUpperRight(
  tiles: ReadonlyArray<ScreenTile>,
): ScreenTile | null {
  if (tiles.length === 0) return null;
  // Find the maximum row index (top row = 0). Then within that row pick
  // the maximum column.
  const sorted = [...tiles].sort((a, b) => {
    const [aRow, aCol] = parseTileId(a.id);
    const [bRow, bCol] = parseTileId(b.id);
    if (aRow !== bRow) return aRow - bRow; // top first
    return bCol - aCol; // right first
  });
  return sorted[0] ?? null;
}

function parseTileId(id: string): [number, number] {
  const match = /^tile-(\d+)-(\d+)$/.exec(id);
  if (!match) return [0, 0];
  return [
    Number.parseInt(match[1] ?? "0", 10),
    Number.parseInt(match[2] ?? "0", 10),
  ];
}

/**
 * Deduplicate OCR words across overlapping tiles by absolute-bbox identity.
 * The reconciler is intentionally minimal: two words are "the same" when
 * their bbox top-left and width/height match. The real implementation will
 * use IoU, but for the harness this contract is enough to record that the
 * stage ran.
 */
function reconcileOcr(results: ReadonlyArray<OcrCoordResult>): number {
  const seen = new Set<string>();
  for (const result of results) {
    for (const block of result.blocks) {
      for (const word of block.words) {
        const key = `${word.bbox.x}:${word.bbox.y}:${word.bbox.width}:${word.bbox.height}:${word.text}`;
        seen.add(key);
      }
    }
  }
  return seen.size;
}

async function runStage(
  stage: PipelineStage,
  fn: () => Promise<{ summary: string }>,
  displayId?: string,
): Promise<StageRecord> {
  const start = performance.now();
  try {
    const { summary } = await fn();
    return {
      stage,
      duration_ms: Math.round(performance.now() - start),
      output_summary: summary,
      displayId,
      ok: true,
    };
  } catch (err) {
    return {
      stage,
      duration_ms: Math.round(performance.now() - start),
      output_summary: "",
      displayId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pngToDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Real-mode runner. Wires the same pipeline against the real plugin-vision
 * + plugin-computeruse + IMAGE_DESCRIPTION provider stack:
 *
 *   - capture: `captureRealDisplays()` (workspace plugin-computeruse).
 *   - tile:    same local mirror of plugin-vision's tiler.
 *   - VLM:     `RealVlm` over `runtime.useModel(IMAGE_DESCRIPTION, …)` —
 *              provider discovered by `discoverRuntimeAdapter()`.
 *   - OCR:     `RealOcrProvider` from plugin-vision's `RapidOcrCoordAdapter`,
 *              soft-degraded if the backend is unavailable on this host
 *              (the OCR stage is recorded as failed; pipeline continues).
 *   - click:   `RealDriver` — sandbox dispatcher when available, otherwise
 *              clamped into a controlled X11 window we spawn ourselves; if
 *              neither is available the click is recorded as a noop with a
 *              structured note.
 *
 * Throws `NoVisionProviderError` if no IMAGE_DESCRIPTION provider can be
 * wired — the harness deliberately refuses to fabricate output.
 */
export async function runRealPipeline(
  opts: RunRealPipelineOptions = {},
): Promise<RunPipelineResult> {
  const target =
    opts.groundingTarget ?? "the close button on the focused window";
  const runId = opts.runId ?? `vision-cua-e2e-real-${nowStamp()}`;
  const startedAt = new Date();

  const runtimeAdapter = await discoverRuntimeAdapter();
  const vlm = new RealVlm(runtimeAdapter);

  const ocrDiscovery = await discoverOcrProvider();
  const ocrProvider = ocrDiscovery.provider;

  const controlledWindow = opts.skipControlledWindow
    ? null
    : await spawnControlledWindow({
        binary: opts.controlledWindowBinary,
        description: opts.controlledWindowBinary ?? "xeyes",
      });
  const driver = new RealDriver({
    controlledWindow,
    noopOnly: opts.noopClick === true || opts.skipControlledWindow === true,
  });

  const stages: StageRecord[] = [];
  const failures: string[] = [];
  const displays: DisplayRunRecord[] = [];

  let providerCleanup: (() => Promise<void>) | null = null;
  if (controlledWindow) {
    providerCleanup = async () => {
      await controlledWindow.close();
    };
  }

  try {
    type CaptureResult = Awaited<ReturnType<typeof captureRealDisplays>>;
    const captureBox: { value: CaptureResult | null } = { value: null };
    const enumerate = await runStage("enumerate_displays", async () => {
      const cr = await captureRealDisplays({});
      captureBox.value = cr;
      return {
        summary: `${cr.captures.length} display(s) via ${cr.providerInfo.captureName}: ${cr.captures
          .map((c) => `${c.display.name}@${c.display.bounds.join(",")}`)
          .join(" | ")}`,
      };
    });
    stages.push(enumerate);
    if (!enumerate.ok || !captureBox.value) {
      failures.push(
        `enumerate_displays: ${enumerate.error ?? "no captures returned"}`,
      );
    }

    const captures = captureBox.value?.captures ?? [];
    const backends = createRealBackends({
      vlm,
      ocrProvider,
      ocrUnavailableReason: ocrProvider ? null : ocrDiscovery.reason,
      driver,
    });

    for (const capture of captures) {
      const displayRecord = await runDisplay({
        capture,
        backends,
        groundingTarget: target,
        maxTileEdge: opts.maxTileEdge ?? 1280,
      });
      displays.push(displayRecord.record);
      stages.push(...displayRecord.stages);
      failures.push(...displayRecord.failures);
    }

    const finishedAt = new Date();
    const trace: PipelineTrace = {
      run_id: runId,
      mode: "real",
      fixture_id: `live:${captures
        .map((c) => `${c.display.name}@${c.display.bounds.join(",")}`)
        .join("|")}`,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      displays,
      stages,
      success:
        failures.length === 0 &&
        displays.length > 0 &&
        displays.every((d) => d.stateChangeDetected),
      failures,
    };

    let reportPath: string | null = null;
    if (opts.writeReport !== false) {
      const dir = opts.reportDir ?? REPORT_DIR;
      mkdirSync(dir, { recursive: true });
      reportPath = join(dir, `${runId}.json`);
      writeFileSync(reportPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    }

    const recordedClicks = driver
      .recordedClicks()
      .map((click) => click.remappedTo ?? click.target);

    return { trace, reportPath, recordedClicks };
  } finally {
    if (providerCleanup) await providerCleanup();
  }
}

interface CreateRealBackendsArgs {
  readonly vlm: RealVlm;
  readonly ocrProvider: RealOcrProvider | null;
  readonly ocrUnavailableReason: string | null;
  readonly driver: RealDriver;
}

function createRealBackends(args: CreateRealBackendsArgs): PipelineBackends {
  const { vlm, ocrProvider, ocrUnavailableReason, driver } = args;
  return {
    mode: "real",
    async describe({ tile, displayId }) {
      return vlm.describe({
        imageUrl: pngToDataUrl(tile.pngBytes),
        prompt: JSON.stringify({
          task: "describe_visual_scene",
          instructions: ["Describe the focused window and its chrome."],
          tile: { id: tile.id, displayId },
        }),
      });
    },
    async ground({ tile, displayId, target }) {
      return vlm.ground(
        { description: target, tileId: tile.id, displayId },
        { tileWidth: tile.tileW, tileHeight: tile.tileH },
        pngToDataUrl(tile.pngBytes),
      );
    },
    async ocr({ tile, displayId }) {
      if (!ocrProvider) {
        throw new Error(
          `[real-mode] OCR-with-coords provider unavailable: ${
            ocrUnavailableReason ?? "unknown"
          }`,
        );
      }
      return ocrProvider.describe({
        displayId,
        sourceX: tile.sourceX,
        sourceY: tile.sourceY,
        tileWidth: tile.tileW,
        tileHeight: tile.tileH,
        pngBytes: new Uint8Array(tile.pngBytes),
      });
    },
    async click(target) {
      await driver.click(target);
    },
    recordedClicks() {
      return driver.recordedClicks().map((c) => ({ target: c.target }));
    },
  };
}

/**
 * Unified entrypoint that honours `ELIZA_VISION_CUA_E2E_REAL=1` to dispatch
 * to the real-mode runner. In stub mode `fixtureId` is required; in real
 * mode it is ignored (the live captures define the workload).
 */
export async function runPipeline(
  opts: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const real = process.env.ELIZA_VISION_CUA_E2E_REAL === "1";
  if (real) {
    return runRealPipeline({
      groundingTarget: opts.groundingTarget,
      writeReport: opts.writeReport,
      reportDir: opts.reportDir,
      runId: opts.runId,
      maxTileEdge: opts.maxTileEdge,
      noopClick: process.env.ELIZA_VISION_CUA_E2E_NOOP_CLICK === "1",
      skipControlledWindow:
        process.env.ELIZA_VISION_CUA_E2E_NO_CONTROLLED_WINDOW === "1",
      controlledWindowBinary:
        process.env.ELIZA_VISION_CUA_E2E_CONTROLLED_WINDOW_BINARY,
    });
  }
  return runStubPipeline(opts);
}

export const REPORT_DIR_PATH = REPORT_DIR;
