/**
 * View-bundle-size regression gate (issue #10724).
 *
 * A device-independent, deterministic bundle-size guardrail. It builds every
 * plugin's view bundle via the existing view-bundle vite build
 * (`packages/scripts/build-views.mjs` — the same build the view-bundle import
 * guard already relies on), measures the gzipped (and raw) size of the emitted
 * `dist/views/*.js|css`, compares each bundle plus the total against the
 * committed ceilings in `budgets.json`, prints a table, and exits:
 *   0  every measured bundle (and the total) is at or under budget
 *   1  a measured bundle (or the total) EXCEEDS budget, OR a budgeted bundle
 *      failed to build while the build otherwise works — a regression
 *   2  nothing measurable (no view bundle built on this host) — skip
 *
 * The `1` path is the CI regression gate: a view that grows past its ceiling
 * turns CI red.
 *
 * Honesty contract (see metric-schema.mjs): a bundle that fails to build is
 * `measured: false` with sizes `null` (never `0`) and can NEVER satisfy a
 * budget — "did not build" never reads as "0 bytes, under budget".
 *
 * Run:
 *   node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs
 *   node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs --json
 *   node packages/benchmarks/view-bundle-size/bundle-size-kpi.mjs --no-build   # measure an existing dist
 */

import { spawnSync } from "node:child_process";
import {
  join,
  kb,
  listViewBundlePlugins,
  loadBudgets,
  measureViewBundle,
  REPO_ROOT,
  recordResult,
} from "./lib.mjs";
import {
  BUNDLE_METRIC_SCHEMA,
  compareBundleBudget,
  compareTotalBudget,
  measuredBundleRow,
  skippedBundleRow,
} from "./metric-schema.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
const NO_BUILD = process.argv.includes("--no-build");

/** Build every plugin view bundle via the existing build-views orchestrator. */
function buildViewBundles() {
  const script = join(REPO_ROOT, "packages", "scripts", "build-views.mjs");
  const res = spawnSync(process.execPath, [script], {
    stdio: JSON_ONLY ? ["ignore", "ignore", "inherit"] : "inherit",
    cwd: REPO_ROOT,
    env: process.env,
  });
  if (res.error) {
    console.error(
      `[view-bundle-size] failed to spawn view build: ${res.error.message}`,
    );
    return 1;
  }
  return res.status ?? 1;
}

function main() {
  const budgets = loadBudgets();
  const plugins = listViewBundlePlugins();

  // Build unless the caller measures a pre-built dist (CI builds in a prior step
  // and runs with --no-build for cleaner logs). A non-zero build status is NOT
  // fatal on its own: we still measure whatever bundles landed, and a budgeted
  // bundle that failed to build becomes a failing check below (never a silent 0).
  let buildStatus = null;
  if (!NO_BUILD) {
    if (!JSON_ONLY) console.log(">>> building view bundles…");
    buildStatus = buildViewBundles();
  }

  const rows = plugins.map((name) => {
    const m = measureViewBundle(name);
    if (m.built) {
      return measuredBundleRow(name, {
        rawBytes: m.rawBytes,
        gzipBytes: m.gzipBytes,
        files: m.files,
      });
    }
    const reason = NO_BUILD
      ? "no built dist/views (run `bun run build:views` first)"
      : "view build produced no dist/views/*.js|css";
    return skippedBundleRow(name, reason);
  });

  const measured = rows.filter((r) => r.measured);
  const measuredCount = measured.length;
  const totalGzip = measured.reduce((s, r) => s + r.gzipBytes, 0);
  const totalRaw = measured.reduce((s, r) => s + r.rawBytes, 0);

  // Per-bundle checks: only bundles that carry a budget are gated. A measured
  // bundle with no budget is reported as an un-budgeted note (non-gating, but
  // it still counts toward the total budget). A budgeted bundle that did not
  // build fails its check whenever the build otherwise works (measuredCount>0);
  // when NOTHING built we skip (exit 2) instead.
  const checks = [];
  const unbudgeted = [];
  for (const row of rows) {
    const budget = budgets.bundles?.[row.name]?.gzipBudgetBytes;
    if (typeof budget !== "number") {
      if (row.measured) unbudgeted.push(row.name);
      continue;
    }
    if (!row.measured && measuredCount === 0) continue; // whole run is a skip
    checks.push(compareBundleBudget(row, budget));
  }

  // Total-across-bundles check.
  const totalBudget = budgets.totalGzipBudgetBytes;
  if (typeof totalBudget === "number" && measuredCount > 0) {
    checks.push(
      compareTotalBudget(totalGzip, totalBudget, {
        measuredBundles: measuredCount,
      }),
    );
  }

  const pass = checks.length > 0 && checks.every((c) => c.pass);
  const skipped = measuredCount === 0;

  const result = {
    schema: BUNDLE_METRIC_SCHEMA,
    target: "plugin view bundles (dist/views/*.js|css, gzip level 9)",
    build: { ran: !NO_BUILD, status: buildStatus },
    status: skipped ? "skipped" : pass ? "pass" : "fail",
    summary: {
      expectedBundles: plugins.length,
      measuredBundles: measuredCount,
      skippedBundles: plugins.length - measuredCount,
      totalRawBytes: measuredCount > 0 ? totalRaw : null,
      totalGzipBytes: measuredCount > 0 ? totalGzip : null,
      totalGzipBudgetBytes:
        typeof totalBudget === "number" ? totalBudget : null,
      unbudgeted,
    },
    bundles: rows,
    checks,
    pass,
  };

  const { file } = recordResult("view-bundle-size", result, NOW);

  if (JSON_ONLY) {
    console.log(JSON.stringify({ ...result, file }, null, 2));
  } else {
    print(result, file);
  }

  // Exit: nothing measurable => 2 (skip). Otherwise 0 pass / 1 regression.
  if (measuredCount === 0) {
    process.exit(2);
  }
  process.exit(pass ? 0 : 1);
}

function print(r, file) {
  const s = r.summary;
  console.log("\n=== View-bundle-size gate (#10724) ===");
  console.log(
    `target:   ${r.target}\n` +
      `measured: ${s.measuredBundles} / ${s.expectedBundles} bundles` +
      (s.skippedBundles ? `  (${s.skippedBundles} did not build)` : ""),
  );
  if (s.measuredBundles > 0) {
    console.log(
      `total:    ${kb(s.totalGzipBytes)} gzip / ${kb(s.totalRawBytes)} raw` +
        (s.totalGzipBudgetBytes != null
          ? `  (budget ${kb(s.totalGzipBudgetBytes)} gzip)`
          : ""),
    );
  }

  const byName = new Map(r.checks.map((c) => [c.name, c]));
  console.log("\n-- per bundle (gzip) --");
  const nameW = Math.max(12, ...r.bundles.map((b) => b.name.length));
  const header =
    "  " +
    "bundle".padEnd(nameW) +
    "  " +
    "gzip".padStart(11) +
    "  " +
    "budget".padStart(11) +
    "  " +
    "raw".padStart(11) +
    "  result";
  console.log(header);
  for (const b of [...r.bundles].sort(
    (a, z) => (z.gzipBytes ?? -1) - (a.gzipBytes ?? -1),
  )) {
    const c = byName.get(b.name);
    const status = !b.measured
      ? c
        ? "FAIL (no build)"
        : "skip (no build)"
      : c
        ? c.pass
          ? "PASS"
          : "FAIL"
        : "— (no budget)";
    console.log(
      "  " +
        b.name.padEnd(nameW) +
        "  " +
        kb(b.gzipBytes).padStart(11) +
        "  " +
        (c?.budget != null ? kb(c.budget) : "—").padStart(11) +
        "  " +
        kb(b.rawBytes).padStart(11) +
        "  " +
        status,
    );
  }

  const totalCheck = byName.get("total.gzipBytes");
  if (totalCheck) {
    console.log(
      `\n  ${totalCheck.pass ? "PASS" : "FAIL"}  total.gzipBytes: ` +
        `${kb(totalCheck.gzipBytes)} / ≤ ${kb(totalCheck.budget)}`,
    );
  }

  if (s.unbudgeted.length > 0) {
    console.log(
      `\nnote: ${s.unbudgeted.length} measured bundle(s) have no per-bundle budget ` +
        `(add one to budgets.json): ${s.unbudgeted.join(", ")}`,
    );
  }

  const verdict = r.status === "skipped" ? "SKIP" : r.pass ? "PASS" : "FAIL";
  console.log(`\nresult: ${verdict}   recorded -> ${file}`);
  if (s.measuredBundles === 0) {
    console.log(
      "note: no view bundle built on this host — nothing measurable (skip).\n",
    );
  } else {
    console.log("");
  }
}

main();
