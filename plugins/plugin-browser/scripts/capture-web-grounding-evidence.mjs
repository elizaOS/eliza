#!/usr/bin/env node
/**
 * Evidence capture for the web-element grounding lane (#10333).
 *
 * Renders each ScreenSpot-Web-style task in a real Chromium, overlays the
 * target's TRUE on-screen bbox (orange outline) and the grounder's predicted
 * click point (cyan dot), screenshots it, and writes a scorecard. Artifacts land
 * under `test-results/evidence/10333-web-grounding/`.
 *
 * Usage (from repo root):  bun plugins/plugin-browser/scripts/capture-web-grounding-evidence.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const OUT =
  process.env.OUT ||
  join(repoRoot, "test-results", "evidence", "10333-web-grounding");
mkdirSync(OUT, { recursive: true });

const { createChromiumBenchmarkEngine } = await import(
  "../src/benchmark/chromium-executor.ts"
);
const { scoreWebGrounding, centerGrounder, WEB_GROUNDING_TASKS } = await import(
  "../src/benchmark/web-grounding.ts"
);

const engine = await createChromiumBenchmarkEngine({ headless: true });
console.log(`[grounding] engine: ${engine.executablePath}`);

let i = 0;
const captured = [];
const score = await scoreWebGrounding(
  engine,
  WEB_GROUNDING_TASKS,
  centerGrounder,
  async ({ task, box, predicted, correct }) => {
    i += 1;
    const page = engine.currentPage();
    if (!page) return;
    const tag = `${String(i).padStart(2, "0")}-${task.id}`;
    console.log(`[grounding] ${tag}: overlay`);
    // Overlay the ground-truth bbox + the predicted point, then screenshot.
    await page.evaluate(
      ({ box, predicted }) => {
        const mk = (style) => {
          const d = document.createElement("div");
          d.style.cssText = style;
          d.style.position = "fixed";
          d.style.zIndex = "999999";
          d.style.pointerEvents = "none";
          document.body.appendChild(d);
        };
        mk(
          `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;` +
            `border:3px solid #ff5800;border-radius:6px;box-shadow:0 0 0 2px rgba(255,88,0,.3)`,
        );
        if (predicted) {
          mk(
            `left:${predicted.x - 7}px;top:${predicted.y - 7}px;width:14px;height:14px;` +
              `background:#34d6ff;border:2px solid #001018;border-radius:50%`,
          );
        }
      },
      { box, predicted },
    );
    console.log(`[grounding] ${tag}: screenshot`);
    // Puppeteer's screenshot path can stall when request interception is still
    // enabled on some Chromium builds. The page is already fully rendered and
    // overlaid, and this executor page is disposed immediately after the sample.
    await page.setRequestInterception(false).catch(() => {});
    await page.screenshot({ path: join(OUT, `${tag}.png`) });
    captured.push({
      tag,
      task: task.id,
      group: task.group,
      correct,
      box,
      predicted,
    });
    console.log(
      `[grounding] ${tag}: ${correct ? "HIT" : "MISS"} — point (${Math.round(predicted.x)},${Math.round(predicted.y)}) in bbox [${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}]`,
    );
  },
);

await engine.close();

const report = {
  benchmark: "web-element-grounding (ScreenSpot-Web style)",
  engine: "chromium",
  executablePath: engine.executablePath,
  grounder: "center",
  total: score.total,
  correct: score.correct,
  accuracy: score.accuracy,
  byGroup: score.byGroup,
  samples: captured,
};
writeFileSync(
  join(OUT, "scorecard.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  `\n[grounding] accuracy ${score.correct}/${score.total} (${score.accuracy}) → ${OUT}`,
);
process.exit(score.accuracy === 1 ? 0 : 1);
