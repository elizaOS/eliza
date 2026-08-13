/**
 * Aggregates the sharded Story Gate reports into the single canonical verdict.
 *
 * The gate is only meaningful if the merged manifest exactly covers the
 * Storybook catalog discovered at build time, so every shard report must be
 * present, well-formed, uniquely identified, and free of duplicate or unknown
 * story ids. Any of those conditions failing is an aggregation failure, not a
 * pass with a smaller manifest: a cancelled or truncated shard must never be
 * able to produce a green run.
 */
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const REPORT_SCHEMA = "eliza_story_gate_v1";
const SHARD_PATTERN = /^[1-9]\d*\/[1-9]\d*$/;
const STORY_VERDICTS = new Set(["good", "broken", "needs-runtime"]);

function entriesFromCatalog(catalog) {
  return Object.values(catalog?.entries ?? catalog?.stories ?? {});
}

export function storyIdsFromCatalog(catalog) {
  const ids = entriesFromCatalog(catalog)
    .filter((entry) => entry?.type === "story" && typeof entry.id === "string")
    .map((entry) => entry.id)
    .sort((a, b) => a.localeCompare(b));

  const duplicates = ids.filter((id, index) => ids[index - 1] === id);
  if (duplicates.length) {
    throw new Error(`duplicate catalog story ids: ${[...new Set(duplicates)].join(", ")}`);
  }
  return ids;
}

function list(values) {
  return values.length ? values.join(", ") : "none";
}

function validateReports(reports, expectedShards) {
  if (!Array.isArray(reports)) throw new Error("reports must be an array");
  if (
    expectedShards.some(
      (shard) => typeof shard !== "string" || !SHARD_PATTERN.test(shard),
    )
  ) {
    throw new Error("expectedShards must contain valid shard ids");
  }
  const expected = new Set(expectedShards);
  if (expected.size !== expectedShards.length) {
    throw new Error("expectedShards must not contain duplicates");
  }
  const seen = new Set();

  for (const report of reports) {
    if (!report || typeof report !== "object") {
      throw new Error("invalid shard report");
    }
    if (report.schema !== REPORT_SCHEMA) {
      throw new Error(`invalid shard report schema: ${report.schema ?? "missing"}`);
    }
    if (typeof report.shard !== "string" || !expected.has(report.shard)) {
      throw new Error(`unexpected shard report: ${report.shard ?? "missing"}`);
    }
    if (seen.has(report.shard)) {
      throw new Error(`duplicate shard report: ${report.shard}`);
    }
    if (!Array.isArray(report.results) || !Array.isArray(report.failures)) {
      throw new Error(`invalid shard report payload: ${report.shard}`);
    }
    if (report.totals?.stories !== report.results.length) {
      throw new Error(`shard story count mismatch: ${report.shard}`);
    }
    if (report.totals?.failures !== report.failures.length) {
      throw new Error(`shard failure count mismatch: ${report.shard}`);
    }
    for (const failure of report.failures) {
      if (
        !failure ||
        typeof failure !== "object" ||
        typeof failure.kind !== "string" ||
        typeof failure.detail !== "string"
      ) {
        throw new Error(`invalid shard failure entry: ${report.shard}`);
      }
      if (failure.id !== undefined && typeof failure.id !== "string") {
        throw new Error(`invalid shard failure entry: ${report.shard}`);
      }
      if (failure.kind !== "fatal" && typeof failure.id !== "string") {
        throw new Error(`invalid shard failure entry: ${report.shard}`);
      }
    }
    seen.add(report.shard);
  }

  const missing = expectedShards.filter((shard) => !seen.has(shard));
  if (missing.length) throw new Error(`missing shard report: ${missing.join(", ")}`);
}

function summarize(results) {
  return {
    stories: results.length,
    good: results.filter((result) => result.verdict === "good").length,
    broken: results.filter((result) => result.verdict === "broken").length,
    needsRuntime: results.filter((result) => result.verdict === "needs-runtime").length,
    withConsoleErrors: results.filter((result) => result.consoleErrors?.length).length,
    withA11yViolations: results.filter((result) => result.a11y?.length).length,
    playExpected: results.filter((result) => result.play?.expected).length,
    playPrepared: results.filter((result) => result.play?.prepared).length,
  };
}

function validateResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("invalid story result");
  }
  if (typeof result.id !== "string" || !result.id) {
    throw new Error("story result is missing an id");
  }
  if (!STORY_VERDICTS.has(result.verdict)) {
    throw new Error(`invalid story verdict for ${result.id}: ${result.verdict ?? "missing"}`);
  }
}

export function mergeStoryGateReports({ catalog, reports, expectedShards }) {
  if (!Array.isArray(expectedShards) || expectedShards.length === 0) {
    throw new Error("expectedShards must be a non-empty array");
  }
  validateReports(reports, expectedShards);

  const catalogIds = storyIdsFromCatalog(catalog);
  const catalogSet = new Set(catalogIds);
  const results = reports
    .flatMap((report) => report.results)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const seen = new Set();
  const duplicates = [];
  const unexpected = [];

  for (const result of results) {
    validateResult(result);
    if (seen.has(result.id)) duplicates.push(result.id);
    seen.add(result.id);
    if (!catalogSet.has(result.id)) unexpected.push(result.id);
  }

  if (duplicates.length) {
    throw new Error(`duplicate story id: ${[...new Set(duplicates)].join(", ")}`);
  }
  if (unexpected.length) {
    throw new Error(`unexpected story ids: ${[...new Set(unexpected)].join(", ")}`);
  }

  const missing = catalogIds.filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`missing story ids: ${list(missing)}`);

  const summary = summarize(results);
  if (
    results.length > 5 &&
    summary.good === 0 &&
    summary.broken === 0 &&
    summary.needsRuntime === results.length
  ) {
    throw new Error(
      `aggregate self-check failed: all ${results.length} stories are needs-runtime and none rendered good`,
    );
  }

  const failures = reports.flatMap((report) =>
    report.failures.map((failure) => ({ ...failure, shard: report.shard })),
  );

  return {
    schema: REPORT_SCHEMA,
    aggregation: {
      expectedShards,
      receivedShards: reports.map((report) => report.shard).sort(),
      catalogStories: catalogIds.length,
    },
    totals: { ...summary, failures: failures.length },
    failures,
    results,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function writeArtifacts(outDir, merged) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "screenshots"), { recursive: true });

  const cells = merged.results
    .map(
      (result) =>
        `<figure><img loading="lazy" src="screenshots/${escapeHtml(result.id)}.png" alt="${escapeHtml(result.title)}/${escapeHtml(result.name)}"><figcaption>${escapeHtml(result.title)}/${escapeHtml(result.name)}</figcaption></figure>`,
    )
    .join("\n");
  await writeFile(
    join(outDir, "contact-sheet.html"),
    `<!doctype html><meta charset="utf-8"><title>Story Gate Contact Sheet</title><style>body{background:#0a0a0a;color:#eee;font-family:system-ui;margin:0;padding:16px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}figure{margin:0;border:1px solid #2d3436;border-radius:6px;overflow:hidden;background:#111}img{width:100%;display:block;min-height:80px;background:#000}figcaption{padding:4px 6px;font:11px monospace}</style><h1>Story Gate - ${merged.results.length} stories</h1><main>${cells}</main>`,
  );

  const withLogs = merged.results
    .filter(
      (result) =>
        result.consoleErrors?.length || result.issues?.length || result.logCapture,
    )
    .map((result) => ({
      id: result.id,
      title: `${result.title}/${result.name}`,
      verdict: result.verdict,
      consoleErrors: result.consoleErrors ?? [],
      issues: result.issues ?? [],
      capture: result.logCapture ?? null,
    }));
  await writeFile(
    join(outDir, "frontend-logs.json"),
    JSON.stringify(
      {
        schema: "eliza_story_gate_frontend_logs_v2",
        summary: {
          stories: merged.results.length,
          withConsoleErrors: merged.results.filter((result) => result.consoleErrors?.length).length,
          withNetworkFailures: merged.results.filter(
            (result) =>
              (result.logCapture?.summary?.failedResponses ?? 0) +
                (result.logCapture?.summary?.requestFailures ?? 0) >
              0,
          ).length,
          broken: merged.results.filter((result) => result.verdict === "broken").length,
        },
        stories: withLogs,
      },
      null,
      2,
    ),
  );

  const verdict = merged.failures.length
    ? `FAIL: ${merged.failures.length} regression(s)`
    : "PASS: no shard or coverage regressions";
  await writeFile(
    join(outDir, "manual-review.md"),
    `# Story Gate - manual review\n\nGenerated aggregate: ${merged.results.length} stories.\n\n**Verdict:** ${verdict}.\n`,
  );
  await writeFile(join(outDir, "report.json"), JSON.stringify(merged, null, 2));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function mergeStoryGateArtifacts({ catalogPath, inputDir, outDir, shardCount }) {
  const expectedShards = Array.from(
    { length: shardCount },
    (_, index) => `${index + 1}/${shardCount}`,
  );
  const reports = [];
  const screenshotDirs = [];
  let merged;
  try {
    for (let index = 1; index <= shardCount; index++) {
      const shardDir = join(inputDir, `story-gate-shard-${index}-of-${shardCount}`);
      const reportPath = join(shardDir, "report.json");
      const report = await readJson(reportPath).catch(() => {
        throw new Error(`missing shard report: ${index}/${shardCount}`);
      });
      reports.push(report);
      screenshotDirs.push(join(shardDir, "screenshots"));
    }
    merged = mergeStoryGateReports({
      catalog: await readJson(catalogPath),
      reports,
      expectedShards,
    });
    await writeArtifacts(outDir, merged);
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, "report.json"),
      JSON.stringify(
        {
          schema: "eliza_story_gate_aggregate_v1",
          aggregation: { expectedShards },
          totals: { stories: 0, failures: 1 },
          failures: [{ kind: "aggregate-validation", detail: error.message }],
          results: [],
        },
        null,
        2,
      ),
    );
    throw error;
  }
  for (const screenshots of screenshotDirs) {
    await cp(screenshots, join(outDir, "screenshots"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
  if (merged.failures.length) {
    const byShard = new Map();
    for (const failure of merged.failures) {
      byShard.set(failure.shard, (byShard.get(failure.shard) ?? 0) + 1);
    }
    const summary = [...byShard.entries()]
      .map(([shard, count]) => `${shard}: ${count}`)
      .join(", ");
    throw new Error(`shard failures: ${summary}`);
  }
  return merged;
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument: ${flag ?? "missing"}`);
    }
    values[flag.slice(2)] = value;
  }
  const shardCount = Number(values.shards);
  if (!Number.isSafeInteger(shardCount) || shardCount < 1) {
    throw new Error("--shards must be a positive safe integer");
  }
  for (const name of ["catalog", "input", "out"]) {
    if (!values[name]) throw new Error(`--${name} is required`);
  }
  return {
    catalogPath: resolve(values.catalog),
    inputDir: resolve(values.input),
    outDir: resolve(values.out),
    shardCount,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  mergeStoryGateArtifacts(parseCli(process.argv.slice(2))).catch((error) => {
    console.error(`story-gate merge: ${error.message}`);
    process.exit(1);
  });
}
