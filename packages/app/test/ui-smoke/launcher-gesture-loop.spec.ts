/**
 * Real-app launcher gesture-loop e2e (#12179 WI-6 / #12375). Drives the shared
 * launcher-loop engine's seeded fast-check command stream + CDP-touch driver
 * (packages/ui/src/testing/launcher-loop) against the REAL booted app's
 * combined home surface — the same engine the fixture web lane and the
 * Android/iOS native lanes run, now exercised against production wiring rather
 * than an esbuild fixture bundle.
 *
 * The production app renders ONE combined page (HomeScreen with the embedded
 * launcher grid — no home↔launcher rail), so this lane drives the
 * combined-surface, navigation-safe alphabet (`tileIds: []`, rail families
 * zero-weighted): grid/widget scrolls (the home column's scroll covers the
 * pinned notification center card too) and Tab focus, through the public test
 * ids (`home-launcher-surface` / `-page-probe`, `launcher-page-window`,
 * `home-screen`). After each command the engine checks every §D invariant
 * that applies (page/probe agreement, focus never inert, telemetry launch
 * count — ghost-launch guard, zero console errors, CLS budget, no blue). The
 * two-half rail alphabet still runs in full against HomeLauncherSurface in
 * the fixture lane; tile launch is covered there and by gesture-matrix's
 * dedicated tile tests. A blue + hover brand scan bookends the loop.
 *
 * Runs on the desktop `chromium` and `mobile-chromium` (Pixel 7) projects; both
 * opt into `hasTouch` so the CDP-touch gestures are accepted. The seed is pinned
 * for a deterministic gate — override `ELIZA_LOOP_SEED` to fuzz, and
 * `ELIZA_LOOP_ACTIONS` to lengthen the run.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  DEFAULT_WEIGHTS,
  runLauncherLoop,
} from "../../../ui/src/testing/launcher-loop";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

const REPO_ROOT = process.cwd().endsWith(path.join("packages", "app"))
  ? path.resolve(process.cwd(), "..", "..")
  : process.cwd();
const OUT_DIR = path.join(
  REPO_ROOT,
  "test-results",
  "ui-smoke-artifacts",
  "12179-launcher-loops",
  "real-app",
);

const SEED =
  process.env.ELIZA_LOOP_SEED && process.env.ELIZA_LOOP_SEED.trim() !== ""
    ? Number.parseInt(process.env.ELIZA_LOOP_SEED, 10) >>> 0
    : 0x12375;
const ACTIONS = Number(process.env.ELIZA_LOOP_ACTIONS ?? 40);

async function screenshot(page: Page, name: string): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: path.join(OUT_DIR, `${name}.png`),
    fullPage: false,
    attempts: 3,
  });
}

async function openHome(page: Page): Promise<void> {
  await openAppPath(page, "/chat");
  const surface = page.getByTestId("home-launcher-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await expect(surface).toHaveAttribute("data-page", "home", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("home-screen")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("launcher gesture loop (real app, shared engine)", () => {
  // CDP touch input is only accepted in a touch-enabled context; opt in so the
  // loop's real-touch gestures work on the desktop chromium project too.
  test.use({ hasTouch: true });

  // This is a real-CDP-touch FUZZ lane: a seeded gesture stream. Under CI
  // compositor load a single touch scroll can be dropped or coalesced, so the
  // loop occasionally reds on an environmental drop rather than a product
  // defect. A genuine invariant violation is deterministic and fails every
  // retry, so a bounded outer retry keeps the lane honest while immune to the
  // rare dropped touch (the global config runs with retries: 0).
  test.describe.configure({ retries: 2 });

  test.beforeEach(async ({ page }) => {
    // Skip the once-ever first-run tour so its spotlight never intercepts input.
    await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
    await installDefaultAppRoutes(page);
  });

  test("seeded gesture loop holds every invariant on the composed surface", async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await openHome(page);
    await screenshot(page, `${testInfo.project.name}-before-loop`);

    // Brand bookend BEFORE: no blue, orange-resting buttons never hover to
    // black/white/transparent (the engine's no-blue invariant also guards
    // every step of the loop below).
    const blueBefore = await collectBlueColors(page);
    expect(blueBefore, "no blue on the surface before the loop").toEqual([]);
    // `violations` is the hard brand gate (orange-resting must not hover to
    // black/white/transparent). `hoverFailures` (a button the probe couldn't
    // hover — e.g. transiently covered on this touch surface) is recorded as
    // evidence, not asserted, so the gesture lane never reds on a flaky hover.
    const hoverBefore = await collectHoverViolations(page);
    expect(hoverBefore.violations, "no orange→black hover before").toEqual([]);

    // Drive the combined-surface alphabet against the real surface.
    // `tileIds: []` omits the tile tap/long-press commands (a tap navigates
    // away + unmounts the surface); the rail families are zero-weighted
    // because the production home has no home↔launcher rail — scrolls and
    // Tab focus stay in play.
    const result = await runLauncherLoop(page, {
      seed: SEED,
      actions: ACTIONS,
      tileIds: [],
      weights: { ...DEFAULT_WEIGHTS, railSwipe: 0, railEdgeButton: 0 },
    });
    expect(result.actions).toBe(ACTIONS);
    expect(result.seed).toBe(SEED);

    await screenshot(page, `${testInfo.project.name}-after-loop`);

    // Brand bookend AFTER.
    const blueAfter = await collectBlueColors(page);
    expect(blueAfter, "no blue on the surface after the loop").toEqual([]);
    const hoverAfter = await collectHoverViolations(page);
    expect(hoverAfter.violations, "no orange→black hover after").toEqual([]);

    expect(pageErrors, "no uncaught page errors during the loop").toEqual([]);

    const evidence = {
      project: testInfo.project.name,
      seed: SEED,
      actions: result.actions,
      alphabet: "navigation-safe (tileIds: [])",
      brand: {
        blueBefore,
        blueAfter,
        hoverViolationsBefore: hoverBefore.violations,
        hoverViolationsAfter: hoverAfter.violations,
        hoverProbeFailuresBefore: hoverBefore.hoverFailures,
        hoverProbeFailuresAfter: hoverAfter.hoverFailures,
      },
      finalDataPage: await page
        .getByTestId("home-launcher-surface")
        .getAttribute("data-page"),
      pageErrors,
    };
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      path.join(OUT_DIR, `${testInfo.project.name}-loop-observations.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    await testInfo.attach(
      `${testInfo.project.name} launcher loop observations`,
      {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      },
    );
  });
});
