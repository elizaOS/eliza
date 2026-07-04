/**
 * Runtime harness the `__e2e__` fixture runners share: the ✓/✗ assertion gate,
 * the numbered-screenshot snapper, recorded-video rename, the pass/fail exit, a
 * Chromium `try/finally` scope, and `runBrowserFixtureE2E` — a one-context /
 * one-page / optional-video orchestrator for the common runner shape (bundle →
 * page → drive real gestures → assert → artifacts). Runners with a bespoke shape
 * (multi-page, multi-viewport, pixel-diff) compose the lower-level helpers.
 *
 * `console` is the runners' interface — the ✓/✗ stream is what a human reads and
 * CI captures — so this test tooling logs directly.
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  chromium,
  type LaunchOptions,
  type Page,
} from "playwright";
import {
  type FixtureHtmlOptions,
  type WriteFixturePageOptions,
  writeFixturePage,
} from "./fixture-bundle.ts";

export interface AssertGate {
  /** Log `✓`/`✗ msg`, count failures, and return the boolean result. */
  assert(condition: unknown, message: string): boolean;
  readonly failures: number;
}

/** A ✓/✗ assertion gate with a running failure count (the runners' `assert`). */
export function createAssertGate(): AssertGate {
  let failures = 0;
  return {
    assert(condition, message) {
      const ok = Boolean(condition);
      console.log(`${ok ? "✓" : "✗"} ${message}`);
      if (!ok) failures += 1;
      return ok;
    },
    get failures() {
      return failures;
    },
  };
}

export type Snapper = (page: Page, name: string) => Promise<string>;

/** Numbered PNG screenshotter: `<prefix><nn>-<name>.png` into `outDir`. */
export function createSnapper(options: {
  outDir: string;
  prefix?: string;
  pad?: number;
}): Snapper {
  const { outDir, prefix = "", pad = 2 } = options;
  let shot = 0;
  return async (page, name) => {
    shot += 1;
    const file = `${prefix}${String(shot).padStart(pad, "0")}-${name}.png`;
    await page.screenshot({ path: join(outDir, file) });
    console.log(`  📸 ${file}`);
    return file;
  };
}

/**
 * Rename Playwright's hashed `.webm` recording to a stable name in `outDir`.
 * Returns the destination path, or null when no recording was produced.
 */
export async function renameRecordedVideo(options: {
  videoDir: string;
  outDir: string;
  name: string;
}): Promise<string | null> {
  const { videoDir, outDir, name } = options;
  const videos = (await readdir(videoDir)).filter((file) =>
    file.endsWith(".webm"),
  );
  const recorded = videos[0];
  if (!recorded) return null;
  const dest = join(outDir, name);
  await rename(join(videoDir, recorded), dest);
  console.log(`  🎬 ${name}`);
  return dest;
}

/** Print the pass/fail summary and exit with the matching code. */
export function finishRun(options: {
  failures: number;
  passMessage?: string;
  failMessage?: string;
}): never {
  const { failures } = options;
  if (failures === 0) {
    console.log(options.passMessage ?? "\nALL PASSED");
  } else {
    console.error(options.failMessage ?? `\n${failures} FAILED`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

/** Launch Chromium, run `fn`, and always close the browser. */
export async function withChromium<T>(
  launchOptions: LaunchOptions,
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch(launchOptions);
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

/** Launch budget default: Windows Defender can stall the first CDP handshake. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 300000;

export interface BrowserFixtureScenarioContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** The loaded fixture's `file://` URL. */
  url: string;
  gate: AssertGate;
  snap: Snapper;
  /** `[type] text` console lines captured from the page. */
  logs: string[];
  /** Stringified uncaught page errors. */
  errors: string[];
}

export interface BrowserFixtureConfig {
  /** How to bundle + write the fixture page. */
  page: Omit<WriteFixturePageOptions, keyof Omit<FixtureHtmlOptions, "js">> &
    Omit<FixtureHtmlOptions, "js">;
  /** Context options (viewport, hasTouch, isMobile, deviceScaleFactor, …). */
  context?: BrowserContextOptions;
  /** Enable `.webm` recording and rename it to `<name>` on finish. */
  record?: { name: string };
  /** Chromium launch timeout (ms). */
  launchTimeoutMs?: number;
  /** Scripts injected via `page.addInitScript` before `goto` (pre-boot collectors). */
  initScripts?: string[];
  /** Selector to `waitForSelector` after `goto`, before the scenario runs. */
  waitFor?: string;
  /** Screenshot prefix / pad passed to the snapper. */
  snapPrefix?: string;
  snapPad?: number;
  /** Summary label + messages for `finishRun`. */
  label?: string;
  passMessage?: string;
  failMessage?: string;
}

/**
 * Orchestrate the common runner shape: launch Chromium, open one context (with
 * optional video) + page, wire console/pageerror sinks, load the fixture, run
 * the scenario, then close, rename the video, and exit on the gate's failures.
 */
export async function runBrowserFixtureE2E(
  config: BrowserFixtureConfig,
  scenario: (context: BrowserFixtureScenarioContext) => Promise<void>,
): Promise<never> {
  const outDir = config.page.outDir;
  const videoDir = config.record ? join(outDir, "video") : undefined;
  await mkdir(outDir, { recursive: true });
  if (videoDir) await mkdir(videoDir, { recursive: true });
  const url = await writeFixturePage(config.page);

  const browser = await chromium.launch({
    timeout: config.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
  });
  const gate = createAssertGate();
  const snap = createSnapper({
    outDir,
    prefix: config.snapPrefix,
    pad: config.snapPad,
  });
  const logs: string[] = [];
  const errors: string[] = [];
  try {
    const context = await browser.newContext({
      ...config.context,
      ...(videoDir
        ? {
            recordVideo: {
              dir: videoDir,
              size: config.context?.viewport ?? undefined,
            },
          }
        : {}),
    });
    const page = await context.newPage();
    page.on("console", (message) =>
      logs.push(`[${message.type()}] ${message.text()}`),
    );
    page.on("pageerror", (error) => errors.push(String(error)));
    for (const script of config.initScripts ?? []) {
      await page.addInitScript(script);
    }
    await page.goto(url);
    if (config.waitFor) await page.waitForSelector(config.waitFor);

    await scenario({ browser, context, page, url, gate, snap, logs, errors });

    await page.close();
    if (videoDir && config.record) {
      await renameRecordedVideo({ videoDir, outDir, name: config.record.name });
    }
    await context.close();
  } finally {
    await browser.close();
  }

  return finishRun({
    failures: gate.failures,
    passMessage:
      config.passMessage ??
      (config.label ? `\n${config.label} PASSED` : undefined),
    failMessage:
      config.failMessage ??
      (config.label
        ? `\n${config.label} FAILED (${gate.failures})`
        : undefined),
  });
}
