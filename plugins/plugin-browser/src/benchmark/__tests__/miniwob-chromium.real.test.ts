/**
 * Real-Chromium MiniWoB++ lane (#10333 / #9476 secondary gap).
 *
 * Drives the SAME MiniWoB++ task suite + adapter as the JSDOM lane, but through
 * a REAL Chromium engine (Edge/Chrome via puppeteer-core) — the deferred
 * "real-engine lane" from #9476's Definition of Done. Gated: skips cleanly when
 * no Chromium binary is present (so it never breaks a Chromium-less CI), and is
 * `*.real.test.ts` so the default `vitest run` excludes it. Captures a per-task
 * screenshot from the real browser as evidence.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserBenchmarkAdapter } from "../adapter.js";
import {
  createChromiumBenchmarkExecutor,
  resolveChromiumExecutable,
} from "../chromium-executor.js";
import { OraclePolicy } from "../policy.js";
import { MINIWOB_TASKS } from "../tasks.js";
import type { BrowserCommandExecutor } from "../types.js";

const hasChromium = resolveChromiumExecutable() !== null;
const evidenceDir = join(
  import.meta.dirname,
  "../../../../../.github/issue-evidence/9476-browser-benchmark/chromium",
);

(hasChromium ? describe : describe.skip)(
  "MiniWoB++ benchmark through REAL Chromium (puppeteer-core)",
  () => {
    let executor: BrowserCommandExecutor;
    let screenshot: (path: string) => Promise<void>;
    let dispose: () => Promise<void>;

    beforeAll(async () => {
      mkdirSync(evidenceDir, { recursive: true });
      const c = await createChromiumBenchmarkExecutor({ headless: true });
      executor = c.executor;
      screenshot = c.screenshot;
      dispose = c.dispose;
    }, 60_000);

    afterAll(async () => {
      await dispose?.();
    });

    it("uses a real chromium engine", () => {
      expect(executor.engine).toBe("chromium");
    });

    for (const task of MINIWOB_TASKS) {
      it(`solves ${task.id} via real Chromium (oracle, reward 1)`, async () => {
        const policy = new OraclePolicy();
        const adapter = new BrowserBenchmarkAdapter(executor, {
          maxTrajectoryLength: task.maxSteps,
          timestampSource: () => 0,
        });
        await adapter.loadTask(task, 0);
        for (let i = 0; i < task.maxSteps && !adapter.isTerminated(); i++) {
          const observation = await adapter.getObservation();
          const action = await policy.act({
            observation,
            task,
            seed: 0,
            history: adapter.getTrajectory(),
          });
          const result = await adapter.step(action);
          if (result.done) break;
        }
        await screenshot(join(evidenceDir, `task-${task.id}.png`));
        const reward = await task.reward(adapter.rewardContext(), 0);
        expect(reward, `${task.id} reward`).toBe(1);
        // every executed (non-done) step ran on the real chromium engine
        for (const s of adapter.getTrajectory()) {
          if (s.action.type !== "done") {
            expect(s.commandResult?.mode).toBe("chromium");
          }
        }
      }, 60_000);
    }

    it("noop policy scores 0 on click-button (reward discriminates on the real engine)", async () => {
      const task = MINIWOB_TASKS.find((t) => t.id === "click-button");
      if (!task) throw new Error("click-button task missing");
      const adapter = new BrowserBenchmarkAdapter(executor, {
        maxTrajectoryLength: task.maxSteps,
        timestampSource: () => 0,
      });
      await adapter.loadTask(task, 0);
      // do nothing — just terminate
      await adapter.step({ type: "done" });
      const reward = await task.reward(adapter.rewardContext(), 0);
      expect(reward).toBe(0);
    }, 60_000);
  },
);
