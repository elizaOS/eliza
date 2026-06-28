#!/usr/bin/env node

/**
 * AI-QA vision screenshot review (#9304).
 *
 * Closes the gap the audit named: the existing "review" (color buckets + blank
 * detection) never looks at WHAT the UI shows. This sends each captured
 * screenshot + its per-view expectation to a vision model and records a
 * structured verdict (good / needs-work / broken + reasons / layout issues /
 * brand violations / detected text), then gates on `broken` via a shrinking
 * debt allowlist — the same ratchet as the story gate + aesthetic audit.
 *
 * It consumes the output of `ai-qa-capture.spec.ts`
 * (`reports/ai-qa/<runId>/{manifest.json, captures/<id>/<id>__<vp>__<theme>.{png,json}}`).
 *
 * OPT-IN + CI-SAFE: requires `ANTHROPIC_API_KEY`. With no key it logs and exits
 * 0 (the keyless PR lane is unaffected); wire it into a keyed nightly lane to
 * actually review. Model: `AI_QA_VISION_MODEL` (default a vision-capable Haiku).
 *
 * Usage:
 *   node scripts/ai-qa/review-screenshots.mjs [--run-dir reports/ai-qa/<id>]
 *     [--concurrency 4] [--strict] [--update-debt]
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
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

function parseArgs(argv) {
  const a = { runDir: null, concurrency: 4, strict: false, updateDebt: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--run-dir") a.runDir = argv[++i];
    else if (arg === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (arg === "--strict") a.strict = true;
    else if (arg === "--update-debt") a.updateDebt = true;
  }
  return a;
}

async function latestRunDir() {
  const base = join(REPO_ROOT, "reports", "ai-qa");
  if (!existsSync(base)) return null;
  const entries = (await readdir(base, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return entries.length ? join(base, entries[entries.length - 1]) : null;
}

/** Collect every capture record (one per route × viewport × theme) with a PNG. */
async function loadCaptures(runDir) {
  const capturesDir = join(runDir, "captures");
  if (!existsSync(capturesDir)) return [];
  const out = [];
  for (const routeEntry of await readdir(capturesDir, {
    withFileTypes: true,
  })) {
    if (!routeEntry.isDirectory()) continue;
    const routeDir = join(capturesDir, routeEntry.name);
    for (const f of await readdir(routeDir)) {
      if (!f.endsWith(".json")) continue;
      let rec;
      try {
        rec = JSON.parse(await readFile(join(routeDir, f), "utf8"));
      } catch {
        continue;
      }
      if (!rec.screenshotRelPath) continue;
      const png = join(runDir, rec.screenshotRelPath);
      if (!existsSync(png)) continue;
      out.push({ ...rec, pngPath: png });
    }
  }
  return out;
}

async function reviewOne(capture, labelByRoute) {
  const key = `${capture.routeId}-${capture.viewport}-${capture.theme}`;
  try {
    const base64 = (await readFile(capture.pngPath)).toString("base64");
    const prompt = buildReviewPrompt({
      label: labelByRoute[capture.routeId] || capture.routeId,
      path: capture.routePath,
      viewport: capture.viewport,
      theme: capture.theme,
      issues: (capture.issues ?? []).map((i) =>
        typeof i === "string" ? i : `${i.kind}: ${i.detail}`,
      ),
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
    return { key, ...capture, ...parseVisionVerdict(text) };
  } catch (err) {
    return { key, ...capture, error: err?.message || String(err) };
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      "[vision-review] ANTHROPIC_API_KEY not set — skipping (CI-safe no-op). Set it to run the content review.",
    );
    return;
  }
  const runDir = args.runDir
    ? resolve(REPO_ROOT, args.runDir)
    : await latestRunDir();
  if (!runDir || !existsSync(runDir)) {
    console.error(
      "[vision-review] no ai-qa run dir found. Run `ai-qa-capture.spec.ts` first.",
    );
    process.exit(2);
  }
  const manifest = JSON.parse(
    await readFile(join(runDir, "manifest.json"), "utf8"),
  );
  const labelByRoute = Object.fromEntries(
    (manifest.routes ?? []).map((r) => [r.id, r.label]),
  );
  const captures = await loadCaptures(runDir);
  if (!captures.length) {
    console.error(
      `[vision-review] no captures with screenshots under ${runDir}`,
    );
    process.exit(2);
  }
  console.log(
    `[vision-review] reviewing ${captures.length} screenshots with ${MODEL} (concurrency ${args.concurrency})`,
  );

  const results = await mapPool(captures, args.concurrency, (c) =>
    reviewOne(c, labelByRoute),
  );
  const totals = aggregateVerdicts(results);

  const debtPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "vision-review-debt.json",
  );
  const debt = existsSync(debtPath)
    ? JSON.parse(await readFile(debtPath, "utf8"))
    : {};

  await writeFile(
    join(runDir, "vision-review.json"),
    JSON.stringify(
      {
        model: MODEL,
        totals,
        results: results.map(({ pngPath, buttons, ...r }) => r),
      },
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
      `[vision-review] debt updated (${Object.keys(next).length} entries)`,
    );
    return;
  }

  const failures = gateFailures(results, { debt, strict: args.strict });
  console.log(
    `[vision-review] ${JSON.stringify(totals)} | strict=${args.strict} | undebted failures=${failures.length}`,
  );
  if (failures.length) {
    for (const f of failures.slice(0, 40))
      console.error(
        `  [${f.verdict}] ${f.key}\n      ${f.reasons.join(" | ")}`,
      );
    console.error(`\nReport: ${join(runDir, "vision-review.json")}`);
    process.exit(1);
  }
  console.log(`[vision-review] PASSED — ${join(runDir, "vision-review.json")}`);
}

main().catch((err) => {
  console.error("[vision-review] fatal", err);
  process.exit(1);
});
