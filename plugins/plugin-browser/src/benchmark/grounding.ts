/**
 * Web-element grounding benchmark (#10333 — the ScreenSpot-Web-style lane of
 * #9476's deferred "Needs CI infra" list).
 *
 * Mirrors `plugin-computeruse/src/parity/screenspot.ts`: ScreenSpot scores
 * click-grounding — given an instruction + screenshot, a grounder predicts a
 * click point, and accuracy is whether that point lands in the ground-truth
 * element bbox. This is the plugin-browser analog, wired through the REAL
 * browser screenshot + click path:
 *
 *   1. render a self-contained page in a real Chromium ({@link BrowserCommandExecutor}),
 *   2. take a REAL screenshot (the grounder's image),
 *   3. read each target's REAL bbox back through a BROWSER `get box` command,
 *   4. a grounder predicts a point per sample → `pointInBbox` accuracy, and
 *   5. (end-to-end) click that point for real via a `mouse` command and verify
 *      the navigation reached the correct target — the screenshot→ground→click
 *      loop driven entirely through plugin-browser BROWSER commands.
 *
 * The grounder is a seam (like screenspot.ts): the deterministic CI lane uses
 * the {@link oracleGrounder} (the real bbox centre — always in-box, like the
 * MiniWoB++ oracle), while a real VLM grounder plugs into the same function
 * later. No external dataset is vendored — the samples are produced from the
 * live rendered page, so the lane is self-contained and reproducible.
 */

import type { BrowserCommandExecutor } from "./types.js";

export interface GroundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WebGroundingSample {
  id: string;
  /** Natural-language target description (the grounder's instruction). */
  instruction: string;
  /** Ground-truth element selector (used only to read the real bbox). */
  selector: string;
  /** Ground-truth bbox in page pixels, read from the live render. */
  bbox: GroundingBox;
  /** URL a correct click on this target navigates to (click-path check). */
  expectUrl: string;
}

export interface GroundingPrediction {
  x: number;
  y: number;
}

/** A predicted point lands inside the bbox (edges inclusive). Pure. */
export function pointInBbox(
  point: GroundingPrediction,
  bbox: GroundingBox,
): boolean {
  return (
    point.x >= bbox.x &&
    point.x <= bbox.x + bbox.width &&
    point.y >= bbox.y &&
    point.y <= bbox.y + bbox.height
  );
}

export interface GroundingPage {
  startUrl: string;
  routes: ReadonlyArray<{ url: string; html: string }>;
  targets: ReadonlyArray<{
    selector: string;
    instruction: string;
    expectUrl: string;
  }>;
}

const GROUND_ORIGIN = "https://ground.test";
const GROUND_LABELS = [
  "Settings",
  "Profile",
  "Inbox",
  "Billing",
  "Help",
] as const;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A self-contained grounding page: distinct block link-buttons stacked in a
 * column (non-overlapping bboxes, all above the fold of the default viewport),
 * each navigating to its own `/g/hit-<i>` route so a correct click is verifiable
 * through the REAL navigation, not a fabricated signal.
 */
export function buildGroundingPage(): GroundingPage {
  const targets = GROUND_LABELS.map((label, i) => ({
    selector: `#g-${i}`,
    instruction: `Click the "${label}" button.`,
    expectUrl: `${GROUND_ORIGIN}/g/hit-${i}`,
  }));
  const buttons = GROUND_LABELS.map(
    (label, i) =>
      `<a id="g-${i}" href="/g/hit-${i}" style="display:block;width:240px;` +
      `height:44px;line-height:44px;margin:12px;padding:0 16px;` +
      `background:#eee;border:1px solid #999;text-decoration:none;` +
      `color:#111;font:16px sans-serif;">${escapeHtml(label)}</a>`,
  ).join("\n      ");
  const routes = [
    {
      url: `${GROUND_ORIGIN}/grounding`,
      html: `<!doctype html><html><head><title>Grounding</title></head><body style="margin:0">
      <main id="area">${buttons}</main>
    </body></html>`,
    },
    ...GROUND_LABELS.map((label, i) => ({
      url: `${GROUND_ORIGIN}/g/hit-${i}`,
      html: `<!doctype html><html><head><title>HIT ${i}</title></head><body><h1 id="hit">${escapeHtml(label)} reached</h1></body></html>`,
    })),
  ];
  return { startUrl: `${GROUND_ORIGIN}/grounding`, routes, targets };
}

function asBox(value: unknown): GroundingBox | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.width === "number" &&
    typeof v.height === "number"
  ) {
    return { x: v.x, y: v.y, width: v.width, height: v.height };
  }
  return null;
}

/**
 * Render the grounding page in a real browser, screenshot it, and read every
 * target's real bbox back through `get box`. Returns the samples + the screenshot
 * (base64 PNG) a grounder would consume.
 */
export async function buildWebGroundingSamples(
  executor: BrowserCommandExecutor,
  page: GroundingPage,
): Promise<{
  samples: WebGroundingSample[];
  screenshot: string;
  viewport: { width: number; height: number };
}> {
  for (const route of page.routes) {
    await executor.execute({
      subaction: "network",
      networkAction: "route",
      url: route.url,
      responseBody: route.html,
    });
  }
  await executor.execute({ subaction: "navigate", url: page.startUrl });

  const shot = await executor.execute({ subaction: "screenshot" });
  const screenshot =
    shot.snapshot && typeof shot.snapshot.data === "string"
      ? shot.snapshot.data
      : "";
  const viewportValue = (shot.value ?? {}) as {
    width?: number;
    height?: number;
  };
  const viewport = {
    width: Number(viewportValue.width) || 0,
    height: Number(viewportValue.height) || 0,
  };

  const samples: WebGroundingSample[] = [];
  for (const target of page.targets) {
    const boxResult = await executor.execute({
      subaction: "get",
      getMode: "box",
      selector: target.selector,
    });
    const bbox = asBox(boxResult.value);
    if (!bbox) {
      throw new Error(`Could not read bbox for ${target.selector}`);
    }
    samples.push({
      id: target.selector,
      instruction: target.instruction,
      selector: target.selector,
      bbox,
      expectUrl: target.expectUrl,
    });
  }
  return { samples, screenshot, viewport };
}

export interface WebGroundingSampleResult {
  sampleId: string;
  predicted: GroundingPrediction | null;
  /** Predicted point lands in the ground-truth bbox. */
  inBox: boolean;
  /** A real click at the predicted point navigated to the expected target. */
  clickHit: boolean;
}

export interface WebGroundingScore {
  benchmark: string;
  engine: string;
  grounder: string;
  total: number;
  inBox: number;
  clickHits: number;
  accuracy: number;
  clickAccuracy: number;
  results: WebGroundingSampleResult[];
}

export type WebGrounder = (
  sample: WebGroundingSample,
  screenshot: string,
) => Promise<GroundingPrediction | null> | GroundingPrediction | null;

/**
 * Score a grounder over the live samples: point-in-bbox accuracy AND a real
 * end-to-end click check — re-navigate, click the predicted point through a
 * `mouse` command, and confirm the page reached the target's expected URL.
 */
export async function scoreWebGrounding(
  executor: BrowserCommandExecutor,
  page: GroundingPage,
  samples: readonly WebGroundingSample[],
  grounder: WebGrounder,
  grounderName: string,
): Promise<WebGroundingScore> {
  const results: WebGroundingSampleResult[] = [];
  for (const sample of samples) {
    const predicted = await grounder(sample, "");
    const inBox = predicted ? pointInBbox(predicted, sample.bbox) : false;

    let clickHit = false;
    if (predicted) {
      // Fresh render so prior clicks don't carry over, then click for real.
      await executor.execute({ subaction: "navigate", url: page.startUrl });
      await executor.execute({
        subaction: "mouse",
        mouseAction: "click",
        x: predicted.x,
        y: predicted.y,
      });
      const urlResult = await executor.execute({
        subaction: "get",
        getMode: "url",
      });
      clickHit = urlResult.value === sample.expectUrl;
    }

    results.push({ sampleId: sample.id, predicted, inBox, clickHit });
  }

  const inBox = results.filter((r) => r.inBox).length;
  const clickHits = results.filter((r) => r.clickHit).length;
  return {
    benchmark: "web-element-grounding",
    engine: executor.engine,
    grounder: grounderName,
    total: results.length,
    inBox,
    clickHits,
    accuracy: results.length === 0 ? 0 : inBox / results.length,
    clickAccuracy: results.length === 0 ? 0 : clickHits / results.length,
    results,
  };
}

/** Deterministic oracle: the real bbox centre — always in-box. */
export function oracleGrounder(
  sample: WebGroundingSample,
): GroundingPrediction {
  return {
    x: Math.round(sample.bbox.x + sample.bbox.width / 2),
    y: Math.round(sample.bbox.y + sample.bbox.height / 2),
  };
}

/** Adversarial baseline: top-left corner — outside every target. */
export function cornerGrounder(): GroundingPrediction {
  return { x: 1, y: 1 };
}
