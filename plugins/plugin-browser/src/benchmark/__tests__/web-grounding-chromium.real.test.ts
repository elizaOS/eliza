/**
 * Web-element grounding lane on REAL Chromium (#10333 — the ScreenSpot-Web-style
 * item of #9476's deferred list).
 *
 * The screenshot→ground→click loop, end-to-end through plugin-browser BROWSER
 * commands on a real browser: render a page, REAL screenshot, read each target's
 * REAL bbox via `get box`, a grounder predicts a point, and we both score
 * point-in-bbox AND click that point for real (`mouse`) to confirm the
 * navigation reached the correct target.
 *
 * Excluded from the default `vitest run` (`.real.test.ts`) and self-skips
 * without a Chromium binary; runs in the gated CI lane after
 * `bunx playwright install --with-deps chromium`.
 *
 * Asserts both directions: the oracle grounder (real bbox centre) hits every
 * target (in-box AND click navigates correctly), and the corner baseline hits
 * none — so the grounding score is real, not auto-passing.
 */

import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  resolveChromiumExecutablePath,
} from "../chromium-executor.js";
import {
  buildGroundingPage,
  buildWebGroundingSamples,
  cornerGrounder,
  oracleGrounder,
  pointInBbox,
  scoreWebGrounding,
} from "../grounding.js";

const CHROMIUM = resolveChromiumExecutablePath();

describe.skipIf(!CHROMIUM)(
  "Web-element grounding through real plugin-browser on REAL Chromium (#10333)",
  () => {
    let browser: Browser;
    let closeBrowser: () => Promise<void>;
    beforeAll(async () => {
      ({ browser, close: closeBrowser } =
        await launchChromiumBenchmarkBrowser());
    }, 120_000);
    afterAll(async () => {
      await closeBrowser?.();
    });

    it(
      "produces a real screenshot + real bboxes from the live render",
      async () => {
        const { executor, dispose } = await createChromiumBenchmarkExecutor({
          browser,
        });
        try {
          const page = buildGroundingPage();
          const { samples, screenshot } = await buildWebGroundingSamples(
            executor,
            page,
          );
          expect(samples.length).toBe(page.targets.length);
          // The screenshot is real PNG bytes (base64) from the browser.
          expect(screenshot.length).toBeGreaterThan(100);
          for (const s of samples) {
            // Real, sane bboxes read back through `get box`.
            expect(s.bbox.width, s.id).toBeGreaterThan(0);
            expect(s.bbox.height, s.id).toBeGreaterThan(0);
            // The oracle point lands in its own box.
            expect(pointInBbox(oracleGrounder(s), s.bbox), s.id).toBe(true);
          }
        } finally {
          await dispose();
        }
      },
      120_000,
    );

    it(
      "oracle grounder: 100% in-box AND every real click reaches the target",
      async () => {
        const { executor, dispose } = await createChromiumBenchmarkExecutor({
          browser,
        });
        try {
          const page = buildGroundingPage();
          const { samples } = await buildWebGroundingSamples(executor, page);
          const score = await scoreWebGrounding(
            executor,
            page,
            samples,
            oracleGrounder,
            "oracle",
          );
          expect(score.engine).toBe("chromium");
          expect(score.total).toBe(samples.length);
          expect(score.accuracy).toBe(1);
          expect(score.clickAccuracy).toBe(1);
          for (const r of score.results) {
            expect(r.inBox, r.sampleId).toBe(true);
            expect(r.clickHit, r.sampleId).toBe(true);
          }
        } finally {
          await dispose();
        }
      },
      180_000,
    );

    it(
      "corner baseline: 0% in-box AND no click reaches a target — score is real",
      async () => {
        const { executor, dispose } = await createChromiumBenchmarkExecutor({
          browser,
        });
        try {
          const page = buildGroundingPage();
          const { samples } = await buildWebGroundingSamples(executor, page);
          const score = await scoreWebGrounding(
            executor,
            page,
            samples,
            cornerGrounder,
            "corner",
          );
          expect(score.accuracy).toBe(0);
          expect(score.clickAccuracy).toBe(0);
          for (const r of score.results) {
            expect(r.inBox, r.sampleId).toBe(false);
            expect(r.clickHit, r.sampleId).toBe(false);
          }
        } finally {
          await dispose();
        }
      },
      180_000,
    );
  },
);
