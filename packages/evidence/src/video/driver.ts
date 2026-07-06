/**
 * The single data-driven walkthrough driver: given one validated
 * `WalkthroughDef`, drive a real Playwright chromium context through its steps
 * and produce the raw evidence a walkthrough lane needs — a recorded video,
 * per-step screenshots, an ARIA-snapshot (html-tree) per marked step, and a
 * machine-readable steps-log. One driver runs every walkthrough; the difference
 * between a send-button micro-interaction and a five-view app tour is entirely
 * in the definition, not in code.
 *
 * Playwright is a devDependency imported dynamically: consumers that only ingest
 * pre-recorded videos never pay for it, and its absence surfaces as a typed
 * error rather than a module-load crash. The driver does NOT normalize or ingest
 * — it emits raw artifacts into `out`; `ingestVideo` is the next stage. This
 * keeps capture (needs a browser) and analysis (needs ffmpeg) as independently
 * skippable concerns.
 *
 * Steps fail fast: an assertion that does not hold, or a selector that never
 * appears, throws and aborts the walkthrough — a walkthrough that "passed" while
 * silently skipping half its steps is worse than no evidence. The video is still
 * finalized in a `finally` so a failed run leaves a diagnosable recording.
 */

import fs from "node:fs";
import path from "node:path";
import { EvidenceError } from "../errors.ts";
import type { WalkthroughDef, WalkthroughStep } from "./walkthrough-schema.ts";

// Playwright's public types are not depended on at compile time (devDependency,
// dynamic import), so the surface the driver touches is declared structurally.
// This is the minimum contract the driver needs from chromium/page/context.
interface PwLocator {
  scrollIntoViewIfNeeded(options?: { timeout?: number }): Promise<void>;
  hover(options?: { timeout?: number }): Promise<void>;
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  waitFor(options?: { timeout?: number; state?: string }): Promise<void>;
  first(): PwLocator;
  textContent(options?: { timeout?: number }): Promise<string | null>;
}
interface PwPage {
  goto(url: string, options?: { timeout?: number }): Promise<unknown>;
  locator(selector: string): PwLocator;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: string | ((arg: T) => unknown), arg?: T): Promise<unknown>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<Buffer>;
  ariaSnapshot?(options?: { timeout?: number }): Promise<string>;
  content(): Promise<string>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    recordVideo: { dir: string; size?: { width: number; height: number } };
    baseURL?: string;
  }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwChromium {
  launch(options?: { headless?: boolean }): Promise<PwBrowser>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
// Post-step dwell so the recorded video lingers on each state long enough for a
// human to follow and for ffmpeg scene detection to see distinct frames — the
// steps themselves execute in milliseconds, which would otherwise yield a
// sub-second blur with no reviewable per-step moment.
const DEFAULT_STEP_PAUSE_MS = 700;

/** One executed step's record for the steps-log. */
export interface StepLog {
  index: number;
  action: WalkthroughStep["action"];
  label?: string;
  selector?: string;
  value?: string;
  /** Bundle-relative-ish name of the screenshot captured after this step, if any. */
  screenshot?: string;
  /** Name of the ARIA-snapshot captured after this step, if any. */
  ariaSnapshot?: string;
  durationMs: number;
}

/** Everything one driver run produces on disk under `out`. */
export interface WalkthroughRunResult {
  slug: string;
  /** Absolute path to the recorded MP4/webm the browser produced. */
  video: string;
  /** Absolute paths of per-step screenshots, in order. */
  screenshots: string[];
  /** Absolute paths of per-step ARIA snapshots (html-tree YAML), in order. */
  ariaSnapshots: string[];
  /** Absolute path to the written steps-log JSON. */
  stepsLog: string;
  steps: StepLog[];
}

/** Options for {@link runWalkthrough}. */
export interface RunWalkthroughOptions {
  /** Output directory for the video, screenshots, snapshots, and steps-log. */
  out: string;
  /**
   * Base URL for relative `goto` steps. Required when the definition has none
   * and uses a relative goto, and required for `requiresApp` definitions.
   */
  baseUrl?: string;
  /** Injectable chromium for tests; defaults to `@playwright/test`'s chromium. */
  browser?: PwChromium;
  viewport?: { width: number; height: number };
  /** Per-action timeout override (ms). */
  timeoutMs?: number;
  /** Dwell after each step so the video lingers on each state (ms). */
  stepPauseMs?: number;
}

/** Load Playwright's chromium, or throw a typed error when it is unavailable. */
async function loadChromium(): Promise<PwChromium> {
  try {
    const mod = (await import("@playwright/test")) as { chromium: PwChromium };
    return mod.chromium;
  } catch (error) {
    // error-policy:J2 context-adding rethrow — Playwright is a devDependency;
    // its absence is a typed capability gap, not a module crash.
    throw new EvidenceError(
      "Playwright (@playwright/test) is not available; install it to run walkthroughs",
      { code: "PLAYWRIGHT_UNAVAILABLE", cause: error },
    );
  }
}

function resolveUrl(value: string, baseUrl: string | undefined): string {
  if (/^https?:\/\//.test(value)) return value;
  if (baseUrl === undefined) {
    throw new EvidenceError(
      `walkthrough goto '${value}' is relative but no baseUrl was provided`,
      { code: "WALKTHROUGH_NO_BASE_URL", context: { value } },
    );
  }
  return new URL(value, baseUrl).toString();
}

/** Execute one step against the page; throws on any failure (fail-fast). */
async function runStep(
  page: PwPage,
  step: WalkthroughStep,
  baseUrl: string | undefined,
  timeout: number,
): Promise<void> {
  switch (step.action) {
    case "goto":
      await page.goto(resolveUrl(step.value, baseUrl), { timeout });
      return;
    case "click":
      await page.locator(step.selector).first().click({ timeout });
      return;
    case "fill":
      await page.locator(step.selector).first().fill(step.value, { timeout });
      return;
    case "hover":
      await page.locator(step.selector).first().hover({ timeout });
      return;
    case "waitFor":
      if (step.selector !== undefined) {
        await page.locator(step.selector).first().waitFor({ timeout });
      } else {
        await page.waitForTimeout(Number(step.value));
      }
      return;
    case "scroll":
      if (step.selector !== undefined) {
        await page
          .locator(step.selector)
          .first()
          .scrollIntoViewIfNeeded({ timeout });
      } else {
        const px = Number(step.value);
        await page.evaluate<number>(
          "(y) => window.scrollBy(0, y)" as unknown as (arg: number) => unknown,
          px,
        );
      }
      return;
    case "assertText": {
      const scope = step.selector !== undefined ? step.selector : "body";
      const text =
        (await page.locator(scope).first().textContent({ timeout })) ?? "";
      if (!text.includes(step.value)) {
        throw new EvidenceError(
          `assertText failed: '${step.value}' not found in '${scope}'`,
          {
            code: "WALKTHROUGH_ASSERTION_FAILED",
            context: { expected: step.value, scope },
          },
        );
      }
      return;
    }
  }
}

/**
 * Drive a walkthrough definition through a real chromium context and return the
 * produced video, per-step screenshots, ARIA snapshots, and steps-log. The
 * caller normalizes + ingests the video separately (via `ingestVideo`).
 */
export async function runWalkthrough(
  def: WalkthroughDef,
  options: RunWalkthroughOptions,
): Promise<WalkthroughRunResult> {
  const baseUrl = options.baseUrl ?? def.baseUrl;
  if (def.requiresApp && options.baseUrl === undefined) {
    throw new EvidenceError(
      `walkthrough '${def.slug}' requires the booted app; pass baseUrl to run it`,
      { code: "WALKTHROUGH_REQUIRES_APP", context: { slug: def.slug } },
    );
  }
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stepPauseMs = options.stepPauseMs ?? DEFAULT_STEP_PAUSE_MS;
  fs.mkdirSync(options.out, { recursive: true });
  const videoDir = path.join(options.out, ".video");
  fs.mkdirSync(videoDir, { recursive: true });

  const chromium = options.browser ?? (await loadChromium());
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: videoDir, size: viewport },
    ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
  });
  const page = await context.newPage();

  const steps: StepLog[] = [];
  const screenshots: string[] = [];
  const ariaSnapshots: string[] = [];
  let index = 0;
  try {
    for (const step of def.steps) {
      const started = performance.now();
      await runStep(page, step, baseUrl, timeout);
      if (stepPauseMs > 0) await page.waitForTimeout(stepPauseMs);
      const record: StepLog = {
        index,
        action: step.action,
        durationMs: Math.round(performance.now() - started),
        ...(step.label !== undefined ? { label: step.label } : {}),
        ...("selector" in step && step.selector !== undefined
          ? { selector: step.selector }
          : {}),
        ...("value" in step && step.value !== undefined
          ? { value: step.value }
          : {}),
      };
      const tag = `${String(index).padStart(2, "0")}-${slugStep(step)}`;
      if (step.screenshotAfter) {
        const shot = path.join(options.out, `${tag}.png`);
        await page.screenshot({ path: shot });
        screenshots.push(shot);
        record.screenshot = path.basename(shot);
      }
      if (step.ariaAfter) {
        const snapshot = await captureAriaSnapshot(page, timeout);
        const snapPath = path.join(options.out, `${tag}.aria.yaml`);
        fs.writeFileSync(snapPath, snapshot);
        ariaSnapshots.push(snapPath);
        record.ariaSnapshot = path.basename(snapPath);
      }
      steps.push(record);
      index += 1;
    }
  } finally {
    // Closing the context flushes and finalizes the recorded video file.
    await context.close();
    await browser.close();
  }

  const rawVideo = findVideoFile(videoDir);
  const stepsLogPath = path.join(options.out, "steps.json");
  fs.writeFileSync(
    stepsLogPath,
    `${JSON.stringify(
      { schema: 1, slug: def.slug, granularity: def.granularity, steps },
      null,
      2,
    )}\n`,
  );
  return {
    slug: def.slug,
    video: rawVideo,
    screenshots,
    ariaSnapshots,
    stepsLog: stepsLogPath,
    steps,
  };
}

/** Capture Playwright's ARIA snapshot, falling back for older API shapes. */
async function captureAriaSnapshot(
  page: PwPage,
  timeout: number,
): Promise<string> {
  if (typeof page.ariaSnapshot === "function") {
    return page.ariaSnapshot({ timeout });
  }
  throw new EvidenceError(
    "page.ariaSnapshot is unavailable in this Playwright build",
    { code: "ARIA_SNAPSHOT_UNAVAILABLE" },
  );
}

/** Derive a filesystem-safe tag fragment from a step. */
function slugStep(step: WalkthroughStep): string {
  const base =
    step.label ??
    ("selector" in step && step.selector !== undefined
      ? step.selector
      : step.action);
  return (
    base
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || step.action
  );
}

/** Playwright writes the video as a random-named file in `videoDir`. */
function findVideoFile(videoDir: string): string {
  const files = fs
    .readdirSync(videoDir)
    .filter((name) => /\.(webm|mp4|mov)$/i.test(name));
  if (files.length === 0) {
    throw new EvidenceError(
      `no video was recorded in ${videoDir} (context.close did not flush one)`,
      { code: "WALKTHROUGH_NO_VIDEO", context: { videoDir } },
    );
  }
  return path.join(videoDir, files[0]);
}
