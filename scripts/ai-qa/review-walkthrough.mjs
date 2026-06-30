#!/usr/bin/env node

/**
 * Vision review for the full-walkthrough run (#10198 / #10204).
 *
 * The per-route AI-QA reviewer (`review-screenshots.mjs`) only ever sees an
 * isolated route at a time. This adapter binds the SAME vision review library
 * (`review-lib.mjs`) to the ordered walkthrough steps: it reads each
 * `reports/walkthrough/<runId>/<viewport>/steps.json`, sends every captured
 * `NN-<step>.png` + its per-step expectation/diagnostics to the vision model,
 * records a structured good/needs-work/broken verdict, gates `broken` via a
 * shrinking debt allowlist (the same ratchet as the story gate + aesthetic
 * audit), and writes the committed verdict markdown next to JOURNEY.md.
 *
 * OPT-IN + CI-SAFE: requires ANTHROPIC_API_KEY. With no key it logs and exits 0
 * (the keyless PR lane is unaffected). Model: AI_QA_VISION_MODEL (default Haiku).
 *
 * Usage:
 *   node scripts/ai-qa/review-walkthrough.mjs [--run-dir reports/walkthrough/<id>]
 *     [--concurrency 4] [--strict] [--update-debt]
 *     [--verdict-md packages/app/test/ui-smoke/walkthrough/WALKTHROUGH_VERDICTS.md]
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateVerdicts,
  buildReviewPrompt,
  gateFailures,
  imageBlock,
  parseVisionVerdict,
} from "./review-lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MODEL = process.env.AI_QA_VISION_MODEL || "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_VERDICT_MD = join(
  REPO_ROOT,
  "packages/app/test/ui-smoke/walkthrough/WALKTHROUGH_VERDICTS.md",
);

function parseArgs(argv) {
  const a = {
    runDir: null,
    concurrency: 4,
    strict: false,
    updateDebt: false,
    verdictMd: DEFAULT_VERDICT_MD,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-dir") a.runDir = argv[++i];
    else if (arg === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (arg === "--strict") a.strict = true;
    else if (arg === "--update-debt") a.updateDebt = true;
    else if (arg === "--verdict-md")
      a.verdictMd = resolve(REPO_ROOT, argv[++i]);
  }
  return a;
}

async function latestRunDir() {
  const base = join(REPO_ROOT, "reports", "walkthrough");
  if (!existsSync(base)) return null;
  const entries = (await readdir(base, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return entries.length ? join(base, entries[entries.length - 1]) : null;
}

/** Collect every captured step (across viewports) that has a screenshot. */
async function loadCaptures(runDir) {
  const out = [];
  for (const vp of ["desktop", "mobile"]) {
    const stepsPath = join(runDir, vp, "steps.json");
    if (!existsSync(stepsPath)) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(stepsPath, "utf8"));
    } catch {
      continue;
    }
    for (const step of parsed.steps ?? []) {
      if (step.skipped || !step.screenshotRelPath) continue;
      const png = join(
        runDir,
        vp,
        step.screenshotRelPath.replace(`${vp}/`, ""),
      );
      const pngPath = existsSync(png)
        ? png
        : join(runDir, step.screenshotRelPath);
      if (!existsSync(pngPath)) continue;
      out.push({
        key: `${step.id}-${vp}`,
        stepId: step.id,
        stepN: step.n,
        title: step.title,
        expectation: step.expectation,
        viewport: vp,
        lane: step.lane,
        routePath: step.url,
        issues: [
          ...(step.newConsoleErrors ?? []),
          ...(step.newServerErrors ?? []),
        ],
        pngPath,
      });
    }
  }
  // Stable order: by viewport then step number.
  out.sort((a, b) =>
    a.viewport === b.viewport
      ? a.stepN.localeCompare(b.stepN)
      : a.viewport.localeCompare(b.viewport),
  );
  return out;
}

async function reviewOne(capture) {
  try {
    const base64 = (await readFile(capture.pngPath)).toString("base64");
    const prompt = buildReviewPrompt({
      label: `${capture.title} — ${capture.expectation}`,
      path: capture.routePath,
      viewport: capture.viewport,
      theme: "light",
      issues: capture.issues,
    });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [imageBlock(base64), { type: "text", text: prompt }],
          },
        ],
      }),
    });
    if (!res.ok)
      throw new Error(
        `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    const body = await res.json();
    const text = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const verdict = parseVisionVerdict(text);
    return {
      key: capture.key,
      stepN: capture.stepN,
      stepId: capture.stepId,
      title: capture.title,
      viewport: capture.viewport,
      lane: capture.lane,
      ...verdict,
    };
  } catch (err) {
    return {
      key: capture.key,
      stepN: capture.stepN,
      stepId: capture.stepId,
      title: capture.title,
      viewport: capture.viewport,
      lane: capture.lane,
      error: err?.message || String(err),
    };
  }
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function buildVerdictMarkdown({ runId, model, lane, totals, results }) {
  const lines = [];
  lines.push("# Full Walkthrough — Vision Verdicts");
  lines.push("");
  lines.push(
    "Generated by `scripts/ai-qa/review-walkthrough.mjs`. Each row is a per-step",
    "screenshot from the continuous full-walkthrough run, scored by the vision",
    "reviewer against the step's expectation row in `JOURNEY.md`. `broken` outside",
    "the documented debt allowlist fails the gate.",
  );
  lines.push("");
  lines.push(`- Run: \`${runId}\``);
  lines.push(`- Lane: \`${lane}\``);
  lines.push(`- Vision model: \`${model}\``);
  lines.push(
    `- Totals: ${totals.good} good · ${totals["needs-work"]} needs-work · ${totals.broken} broken · ${totals.error} error (of ${totals.total})`,
  );
  lines.push("");
  lines.push("| Step | Viewport | Verdict | Notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const r of results) {
    const badge = r.error
      ? "⚠️ error"
      : r.verdict === "good"
        ? "✅ good"
        : r.verdict === "needs-work"
          ? "🟡 needs-work"
          : "❌ broken";
    const notes = r.error
      ? r.error
      : [
          ...(r.reasons ?? []),
          ...(r.layoutIssues ?? []),
          ...(r.brandViolations ?? []),
        ]
          .join("; ")
          .slice(0, 200) || "—";
    lines.push(
      `| ${r.stepN} ${r.stepId} | ${r.viewport} | ${badge} | ${notes.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "[walkthrough-vision] ANTHROPIC_API_KEY not set — skipping (CI-safe no-op). Set it to run the content review.",
    );
    return;
  }
  const runDir = args.runDir
    ? resolve(REPO_ROOT, args.runDir)
    : await latestRunDir();
  if (!runDir || !existsSync(runDir)) {
    console.error(
      "[walkthrough-vision] no walkthrough run dir found. Run the walkthrough spec first.",
    );
    process.exit(2);
  }
  const manifest = existsSync(join(runDir, "manifest.json"))
    ? JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"))
    : { runId: runDir.split("/").pop(), lane: "unknown" };

  const captures = await loadCaptures(runDir);
  if (!captures.length) {
    console.error(`[walkthrough-vision] no step screenshots under ${runDir}`);
    process.exit(2);
  }
  console.log(
    `[walkthrough-vision] reviewing ${captures.length} step screenshots with ${MODEL} (concurrency ${args.concurrency})`,
  );

  const results = await mapPool(captures, args.concurrency, reviewOne);
  const totals = aggregateVerdicts(results);

  const debtPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "walkthrough-vision-debt.json",
  );
  const debt = existsSync(debtPath)
    ? JSON.parse(await readFile(debtPath, "utf8"))
    : {};

  await writeFile(
    join(runDir, "vision-review.json"),
    JSON.stringify(
      { model: MODEL, runId: manifest.runId, totals, results },
      null,
      2,
    ),
  );

  if (args.updateDebt) {
    const next = {};
    for (const r of results)
      if (r.error || r.verdict === "broken")
        next[r.key] = (r.reasons ?? []).join("; ") || String(r.error);
    await writeFile(
      debtPath,
      JSON.stringify(next, Object.keys(next).sort(), 2),
    );
    console.log(
      `[walkthrough-vision] debt updated (${Object.keys(next).length} entries)`,
    );
  }

  const md = buildVerdictMarkdown({
    runId: manifest.runId,
    model: MODEL,
    lane: manifest.lane,
    totals,
    results,
  });
  await mkdir(dirname(args.verdictMd), { recursive: true });
  await writeFile(args.verdictMd, md);
  console.log(`[walkthrough-vision] verdict markdown → ${args.verdictMd}`);

  const failures = gateFailures(results, { debt, strict: args.strict });
  console.log(
    `[walkthrough-vision] ${JSON.stringify(totals)} | strict=${args.strict} | undebted failures=${failures.length}`,
  );
  if (failures.length) {
    for (const f of failures.slice(0, 40))
      console.error(
        `  [${f.verdict}] ${f.key}\n      ${f.reasons.join(" | ")}`,
      );
    console.error(`\nReport: ${join(runDir, "vision-review.json")}`);
    process.exit(1);
  }
  console.log(
    `[walkthrough-vision] PASSED — ${join(runDir, "vision-review.json")}`,
  );
}

main().catch((err) => {
  console.error("[walkthrough-vision] fatal", err);
  process.exit(1);
});
