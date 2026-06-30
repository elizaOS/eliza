/**
 * Web-element grounding lane (#10333, follow-up to #9476).
 *
 * ScreenSpot-Web-style point-in-bbox grounding wired through the REAL browser
 * screenshot + element-bbox path (a real Chromium via puppeteer-core), mirroring
 * `plugin-computeruse/src/parity/screenspot.ts`. Gated like the other
 * `*.real.test.ts` lanes (run via `vitest.real.config.ts`), self-skips when no
 * Chromium-family browser is resolvable.
 *
 * Asserts both directions: the centre grounder (oracle) lands inside every
 * target's true on-screen bbox (accuracy 1), and the corner grounder lands
 * outside every centred target (accuracy 0) — so the score reads the real
 * rendered geometry, not a hard-coded pass. The engine is proved real by
 * checking the underlying executor reports `engine: "chromium"`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChromiumBenchmarkEngine,
  createChromiumBenchmarkEngine,
  resolveChromiumExecutable,
} from "../chromium-executor.js";
import {
  centerGrounder,
  cornerGrounder,
  scoreWebGrounding,
  WEB_GROUNDING_TASKS,
} from "../web-grounding.js";

const CHROMIUM = resolveChromiumExecutable();

describe.skipIf(!CHROMIUM)(
  "Web-element grounding through a REAL Chromium (#10333)",
  () => {
    let engine: ChromiumBenchmarkEngine;

    beforeAll(async () => {
      engine = await createChromiumBenchmarkEngine({ headless: true });
    }, 120_000);

    afterAll(async () => {
      await engine?.close();
    });

    it("drives the real chromium engine — the executor reports engine: chromium", async () => {
      // Prove the lane is genuinely on the real engine, never a swallowed
      // error or a "web" tag making a broken engine pass.
      const { executor, dispose } = await engine.makeExecutor();
      try {
        expect(executor.engine).toBe("chromium");
        expect(engine.currentPage()).not.toBeNull();
      } finally {
        await dispose();
      }
    }, 120_000);

    it("centre grounder lands inside every target's true on-screen bbox (accuracy 1)", async () => {
      const score = await scoreWebGrounding(
        engine,
        WEB_GROUNDING_TASKS,
        centerGrounder,
      );
      expect(score.total).toBe(WEB_GROUNDING_TASKS.length);
      expect(score.correct).toBe(score.total);
      expect(score.accuracy).toBe(1);
      for (const r of score.results) {
        expect(r.correct, `${r.id}`).toBe(true);
        expect(r.box.width, `${r.id} has a real bbox`).toBeGreaterThan(0);
        expect(r.box.height, `${r.id} has a real bbox`).toBeGreaterThan(0);
      }
      // every breakdown group (button/link/icon) fully grounded
      for (const [group, g] of Object.entries(score.byGroup)) {
        expect(g.accuracy, group).toBe(1);
      }
    }, 180_000);

    it("corner grounder misses every centred target (accuracy 0) — bbox is real", async () => {
      const score = await scoreWebGrounding(
        engine,
        WEB_GROUNDING_TASKS,
        cornerGrounder,
      );
      expect(score.total).toBe(WEB_GROUNDING_TASKS.length);
      expect(score.correct).toBe(0);
      expect(score.accuracy).toBe(0);
    }, 180_000);
  },
);
