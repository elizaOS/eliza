#!/usr/bin/env node
/**
 * Evidence capture for the real-Chromium MiniWoB++ benchmark lane (#10333).
 *
 * Drives the SAME `BrowserBenchmarkAdapter` + oracle through a real Chromium
 * (puppeteer-core) and screenshots each task's start page and post-oracle
 * (solved) page, plus a machine-readable scorecard. Artifacts land under
 * `test-results/evidence/10333-browser-real-chromium/`.
 *
 * Usage (from repo root):
 *   node plugins/plugin-browser/scripts/capture-miniwob-chromium-evidence.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const OUT =
  process.env.OUT ||
  join(repoRoot, "test-results", "evidence", "10333-browser-real-chromium");
mkdirSync(OUT, { recursive: true });

const { createChromiumBenchmarkEngine } = await import(
  "../src/benchmark/chromium-executor.ts"
);
const { BrowserBenchmarkAdapter } = await import("../src/benchmark/adapter.ts");
const { MINIWOB_TASKS } = await import("../src/benchmark/tasks.ts");
const { OraclePolicy } = await import("../src/benchmark/policy.ts");

const SEED = Number(process.env.SEED ?? 0);
const engine = await createChromiumBenchmarkEngine({ headless: true });
console.log(`[evidence] engine: ${engine.executablePath}`);

const policy = new OraclePolicy();
const scorecard = [];

let i = 0;
for (const task of MINIWOB_TASKS) {
  i += 1;
  const { executor, dispose } = await engine.makeExecutor();
  const page = engine.currentPage();
  const adapter = new BrowserBenchmarkAdapter(executor, {
    maxTrajectoryLength: task.maxSteps,
    timestampSource: () => 0,
  });
  const tag = `${String(i).padStart(2, "0")}-${task.id}`;
  try {
    await adapter.loadTask(task, SEED);
    if (page) await page.screenshot({ path: join(OUT, `${tag}-start.png`) });

    let steps = 0;
    for (let s = 0; s < task.maxSteps && !adapter.isTerminated(); s++) {
      const observation = await adapter.getObservation();
      const action = await policy.act({
        observation,
        task,
        seed: SEED,
        history: adapter.getTrajectory(),
      });
      const r = await adapter.step(action);
      steps++;
      if (r.done) break;
    }
    const reward = await task.reward(adapter.rewardContext(), SEED);
    if (page) await page.screenshot({ path: join(OUT, `${tag}-solved.png`) });

    const trajectory = adapter.getTrajectory().map((st) => ({
      action: st.action,
      resultMode: st.commandResult?.mode ?? null,
      error: st.error ? `${st.error.code}: ${st.error.message}` : null,
    }));
    scorecard.push({
      task: task.id,
      seed: SEED,
      engine: executor.engine,
      utterance: task.utterance(SEED),
      reward,
      success: reward >= 1,
      steps,
      trajectory,
    });
    console.log(
      `[evidence] ${tag}: reward=${reward} (${reward >= 1 ? "SOLVED" : "FAILED"}) — ${steps} steps`,
    );
  } catch (err) {
    scorecard.push({ task: task.id, seed: SEED, error: String(err) });
    console.log(`[evidence] ${tag}: ERROR ${err}`);
  } finally {
    await dispose();
  }
}

await engine.close();

const solved = scorecard.filter((s) => s.success).length;
const report = {
  benchmark: "miniwob++",
  engine: "chromium",
  executablePath: engine.executablePath,
  policy: "oracle",
  seed: SEED,
  total: scorecard.length,
  solved,
  successRate: scorecard.length ? solved / scorecard.length : 0,
  episodes: scorecard,
};
writeFileSync(
  join(OUT, "scorecard.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `\n[evidence] ${solved}/${scorecard.length} solved on real Chromium → ${OUT}`,
);
process.exit(solved === scorecard.length ? 0 : 1);
