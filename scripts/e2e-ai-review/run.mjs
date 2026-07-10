#!/usr/bin/env node
/**
 * AI review orchestrator for per-test e2e artifact bundles: walks a run
 * produced under the `scripts/e2e-artifacts/contract.mjs` shapes, builds one
 * reviewer prompt per test (logs, OCR, trajectory digest, posthog histogram,
 * screenshot/video paths), invokes a local reviewer CLI (codex preferred,
 * claude fallback; `ELIZA_AI_REVIEW_CMD` overrides the spawn for tests), and
 * records the structured verdicts: per-test `ai-review/review.json` (also
 * appended to the test manifest), run-level `ai-review/summary.{json,md}`,
 * and a `certify-verdicts.json` consumable by `packages/evidence`
 * `parseReviewerVerdicts`. `--fix` re-invokes the backend in write mode for
 * findings that carry a suggestedFix + files, capturing `git diff --stat`
 * into `ai-review/fixes.log`; it never commits.
 *
 *   node scripts/e2e-ai-review/run.mjs [--run <id>] [--jobs 2] [--max-tests N]
 *     [--backend auto|codex|claude] [--model <m>] [--fix] [--only <substr>]
 *
 * Quota handling: a backend whose invocation classifies as quota is excluded
 * for the rest of the run; when no backend remains, the remaining tests are
 * recorded as skipped (with the reason) rather than silently green.
 *
 * This is a process boundary: console output is the product here.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildRunIndex,
  latestRunId,
  readTestManifest,
  runDir,
  writeTestManifest,
} from "../e2e-artifacts/contract.mjs";
import {
  buildClaudeArgs,
  buildCodexArgs,
  classifyBackendError,
  detectBackends,
  extractLastJsonObject,
  pickBackend,
} from "./cli-backends.mjs";
import { buildReviewPrompt, parseReviewVerdict } from "./review-prompt.mjs";

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const REVIEW_SCHEMA = "elizaos.e2e.ai-review/1";
const SUMMARY_SCHEMA = "elizaos.e2e.ai-review-summary/1";
const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2 };
const INVOCATION_TIMEOUT_MS = Number.parseInt(
  process.env.ELIZA_AI_REVIEW_TIMEOUT_MS ?? "600000",
  10,
);

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: "string" },
      jobs: { type: "string", default: "2" },
      "max-tests": { type: "string" },
      backend: { type: "string", default: "auto" },
      model: { type: "string" },
      fix: { type: "boolean", default: false },
      only: { type: "string" },
    },
  });
  const jobs = Number.parseInt(values.jobs, 10);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`--jobs must be a positive integer, got ${values.jobs}`);
  }
  const maxTests =
    values["max-tests"] === undefined
      ? Infinity
      : Number.parseInt(values["max-tests"], 10);
  if (!Number.isInteger(maxTests) && maxTests !== Infinity) {
    throw new Error(
      `--max-tests must be an integer, got ${values["max-tests"]}`,
    );
  }
  if (!["auto", "codex", "claude"].includes(values.backend)) {
    throw new Error(
      `--backend must be auto|codex|claude, got ${values.backend}`,
    );
  }
  return {
    run: values.run,
    jobs,
    maxTests,
    backend: values.backend,
    model: values.model,
    fix: values.fix,
    only: values.only,
  };
}

function readArtifactText(testDirAbs, artifact) {
  const abs = path.join(testDirAbs, artifact.path);
  try {
    return fs.readFileSync(abs, "utf8");
  } catch (error) {
    // error-policy:J4 an unreadable listed artifact must not kill the whole
    // review; the prompt carries an explicit unreadable marker so the
    // reviewer (and the human reading review.json) sees the gap.
    return `(artifact listed in manifest but unreadable: ${artifact.path}: ${error.message})`;
  }
}

/** Gather everything the prompt inlines or references for one test. */
function collectInlined(testDirAbs, manifest) {
  const byKind = (kind) =>
    (manifest.artifacts ?? []).filter((artifact) => artifact.kind === kind);
  const concat = (kind) => {
    const artifacts = byKind(kind);
    if (artifacts.length === 0) return undefined;
    return artifacts
      .map(
        (artifact) =>
          `=== ${artifact.path} ===\n${readArtifactText(testDirAbs, artifact)}`,
      )
      .join("\n");
  };
  const abs = (artifact) => path.join(testDirAbs, artifact.path);
  const stateShots = byKind("state-screenshot").map(abs);
  const plainShots = byKind("screenshot").map(abs);
  const firstOf = (kind) => {
    const artifacts = byKind(kind);
    return artifacts.length > 0
      ? readArtifactText(testDirAbs, artifacts[0])
      : undefined;
  };
  return {
    consoleLog: concat("console-log"),
    networkLog: concat("network-log"),
    serverLog: concat("server-log"),
    ocrText: concat("ocr"),
    trajectoryRaw: firstOf("trajectory"),
    posthogEventsRaw: firstOf("posthog-events"),
    screenshotPaths: [...stateShots, ...plainShots],
    videoPaths: byKind("video").map(abs),
    // codex -i attachments: state screenshots carry the labeled UI states;
    // plain screenshots only fill the remaining slots.
    imagePaths: [...stateShots, ...plainShots].slice(0, 4),
  };
}

class NoBackendError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "NoBackendError";
  }
}

function spawnCollect(command, args, { input, cwd, shell = false }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: INVOCATION_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Invoke a reviewer CLI, falling over to the next backend when one hits
 * quota. Mutates `state.excluded` so the exclusion holds for the whole run.
 */
async function invokeReviewer(state, { prompt, images = [], write = false }) {
  if (state.overrideCmd) {
    const result = await spawnCollect(state.overrideCmd, [], {
      input: prompt,
      cwd: REPO_ROOT,
      shell: true,
    });
    if (result.code !== 0) {
      const classified = classifyBackendError(
        `${result.stderr}\n${result.stdout}`,
      );
      throw new Error(
        `override reviewer command failed (${classified.kind}, exit ${result.code}): ${result.stderr.slice(0, 500)}`,
      );
    }
    return { backend: "override", model: null, ...result };
  }

  for (;;) {
    const backend = pickBackend({
      preference: state.preference,
      detected: state.detected,
      excluded: state.excluded,
      model: state.model,
    });
    if (!backend) {
      throw new NoBackendError(
        `no reviewer backend available (preference=${state.preference}, quota-excluded=[${[...state.excluded].join(", ")}])`,
      );
    }
    const args =
      backend.name === "codex"
        ? buildCodexArgs({
            model: backend.model,
            repoRoot: REPO_ROOT,
            prompt,
            images,
            write,
          })
        : buildClaudeArgs({ prompt, model: backend.model ?? undefined, write });
    const result = await spawnCollect(backend.command, args, {
      cwd: REPO_ROOT,
    });
    if (result.code === 0) {
      return { backend: backend.name, model: backend.model, ...result };
    }
    const classified = classifyBackendError(
      `${result.stderr}\n${result.stdout}`,
    );
    if (classified.kind === "quota") {
      state.excluded.add(backend.name);
      console.warn(
        `[ai-review] ${backend.name} hit quota (exit ${result.code}); excluding it for the rest of the run`,
      );
      continue;
    }
    throw new Error(
      `${backend.name} invocation failed (${classified.kind}, exit ${result.code ?? `signal ${result.signal}`}): ${(result.stderr || result.stdout).slice(0, 800)}`,
    );
  }
}

// codex exec reports "tokens used: N" on stderr; absent means unknown, and
// the usage record simply omits the field rather than fabricating 0.
function extractTokens(text) {
  const match = /tokens used:?\s+([\d,]+)/i.exec(text);
  if (!match) return undefined;
  return Number.parseInt(match[1].replaceAll(",", ""), 10);
}

async function reviewOneTest(state, indexEntry) {
  // The index's `dir` is ground truth (buildRunIndex scanned it); re-deriving
  // from the id would silently miss a producer that named the dir itself.
  const testDirAbs = path.join(runDir(REPO_ROOT, state.runId), indexEntry.dir);
  const manifest = readTestManifest(testDirAbs);
  if (!manifest) {
    return {
      indexEntry,
      status: "skipped",
      reason: `no readable manifest in ${testDirAbs}`,
    };
  }
  const inlined = collectInlined(testDirAbs, manifest);
  const prompt = buildReviewPrompt(manifest, inlined);

  let invocation;
  let retried = false;
  let parsed;
  try {
    invocation = await invokeReviewer(state, {
      prompt,
      images: inlined.imagePaths,
    });
    parsed = parseExtracted(invocation.stdout);
    if (!parsed.ok) {
      retried = true;
      const nudge = `${prompt}\n\nIMPORTANT: Your previous reply could not be parsed (${parsed.reason}). Respond with ONLY the JSON object described in the output contract — no prose, no markdown fences.`;
      invocation = await invokeReviewer(state, {
        prompt: nudge,
        images: inlined.imagePaths,
      });
      parsed = parseExtracted(invocation.stdout);
    }
  } catch (error) {
    if (error instanceof NoBackendError) {
      return { indexEntry, status: "skipped", reason: error.message };
    }
    // error-policy:J4 one test's backend failure degrades to a recorded
    // needs-eyeball review with the raw error, never a fabricated verdict;
    // other tests in the run proceed.
    const review = writeReview(testDirAbs, manifest, state, {
      verdict: "needs-eyeball",
      confidence: 0,
      findings: [],
      notes: `reviewer invocation failed: ${error.message}`,
      backend: { name: "unavailable", retried },
    });
    return { indexEntry, status: "reviewed", review };
  }

  const backendRecord = {
    name: invocation.backend,
    model: invocation.model ?? undefined,
    durationMs: invocation.durationMs,
    retried,
  };
  const tokens = extractTokens(`${invocation.stderr}\n${invocation.stdout}`);
  if (tokens !== undefined) backendRecord.tokens = tokens;
  recordUsage(state, backendRecord);

  const review = parsed.ok
    ? writeReview(testDirAbs, manifest, state, {
        ...parsed.verdict,
        backend: backendRecord,
      })
    : writeReview(testDirAbs, manifest, state, {
        verdict: "needs-eyeball",
        confidence: 0,
        findings: [],
        notes: `reviewer output was not parseable JSON after retry: ${parsed.reason}`,
        backend: backendRecord,
        raw: invocation.stdout.slice(-8000),
      });
  return { indexEntry, status: "reviewed", review };
}

function parseExtracted(stdout) {
  const object = extractLastJsonObject(stdout);
  if (!object) return { ok: false, reason: "no JSON object found in output" };
  return parseReviewVerdict(object);
}

function recordUsage(state, backendRecord) {
  if (!state.backendUsage[backendRecord.name]) {
    state.backendUsage[backendRecord.name] = {
      invocations: 0,
      totalDurationMs: 0,
    };
  }
  const usage = state.backendUsage[backendRecord.name];
  usage.invocations += 1;
  usage.totalDurationMs += backendRecord.durationMs ?? 0;
  if (backendRecord.tokens !== undefined) {
    usage.tokens = (usage.tokens ?? 0) + backendRecord.tokens;
  }
}

function writeReview(testDirAbs, manifest, state, review) {
  const reviewDir = path.join(testDirAbs, "ai-review");
  fs.mkdirSync(reviewDir, { recursive: true });
  const record = {
    schema: REVIEW_SCHEMA,
    testId: manifest.id,
    runId: state.runId,
    generatedAt: new Date().toISOString(),
    ...review,
  };
  fs.writeFileSync(
    path.join(reviewDir, "review.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const artifacts = (manifest.artifacts ?? []).filter(
    (artifact) => artifact.path !== "ai-review/review.json",
  );
  artifacts.push({
    kind: "ai-review",
    path: "ai-review/review.json",
    label: "AI review",
  });
  writeTestManifest(testDirAbs, { ...manifest, artifacts });
  return record;
}

async function runPool(items, jobs, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(jobs, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

function rankFindings(results) {
  const findings = [];
  for (const result of results) {
    if (result.status !== "reviewed") continue;
    for (const finding of result.review.findings ?? []) {
      findings.push({ testId: result.indexEntry.id, ...finding });
    }
  }
  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  return findings;
}

function toCertifyVerdict(result) {
  const subject = `e2e-test:${result.indexEntry.id}`;
  const evidence =
    result.status === "reviewed"
      ? [`${result.indexEntry.dir}/ai-review/review.json`]
      : [];
  if (result.status === "skipped") {
    return {
      subject,
      verdict: "waived",
      evidence,
      notes: `AI review skipped: ${result.reason}`,
    };
  }
  const { verdict, notes, confidence } = result.review;
  if (verdict === "pass") {
    return { subject, verdict: "pass", evidence, notes: notes || undefined };
  }
  if (verdict === "fail") {
    return { subject, verdict: "fail", evidence, notes: notes || undefined };
  }
  // flaky / needs-eyeball are honest non-answers: waived with the reason, so
  // the certify gate sees a reviewed-but-unresolved subject, never a pass.
  return {
    subject,
    verdict: "waived",
    evidence,
    notes: `AI reviewer verdict '${verdict}' (confidence ${confidence}): ${notes || "no notes"}`,
  };
}

function writeSummaries(state, results) {
  const aiReviewDir = path.join(runDir(REPO_ROOT, state.runId), "ai-review");
  fs.mkdirSync(aiReviewDir, { recursive: true });

  const perVerdict = {
    pass: 0,
    fail: 0,
    flaky: 0,
    "needs-eyeball": 0,
    skipped: 0,
  };
  const tests = results.map((result) => {
    if (result.status === "skipped") {
      perVerdict.skipped += 1;
      return {
        id: result.indexEntry.id,
        dir: result.indexEntry.dir,
        skipped: true,
        reason: result.reason,
      };
    }
    perVerdict[result.review.verdict] += 1;
    return {
      id: result.indexEntry.id,
      dir: result.indexEntry.dir,
      verdict: result.review.verdict,
      confidence: result.review.confidence,
      backend: result.review.backend?.name,
      durationMs: result.review.backend?.durationMs,
      findingCount: (result.review.findings ?? []).length,
    };
  });
  const findings = rankFindings(results);

  const summary = {
    schema: SUMMARY_SCHEMA,
    runId: state.runId,
    generatedAt: new Date().toISOString(),
    backendPreference: state.preference,
    perVerdict,
    tests,
    findings,
    backendUsage: state.backendUsage,
  };
  fs.writeFileSync(
    path.join(aiReviewDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  const md = [
    `# AI review — run ${state.runId}`,
    "",
    `Reviewed ${results.length} test(s) — pass ${perVerdict.pass}, fail ${perVerdict.fail}, flaky ${perVerdict.flaky}, needs-eyeball ${perVerdict["needs-eyeball"]}, skipped ${perVerdict.skipped}.`,
    "",
    "## Verdicts",
    "",
    "| test | verdict | confidence | findings | backend |",
    "| --- | --- | --- | --- | --- |",
    ...tests.map((entry) =>
      entry.skipped
        ? `| ${entry.id} | skipped (${entry.reason}) | — | — | — |`
        : `| ${entry.id} | ${entry.verdict} | ${entry.confidence} | ${entry.findingCount} | ${entry.backend} |`,
    ),
    "",
    "## Findings (ranked)",
    "",
    ...(findings.length === 0
      ? ["No findings."]
      : findings.map(
          (finding) =>
            `- **${finding.severity}** [${finding.area}] ${finding.summary} _(test: ${finding.testId})_\n  - evidence: ${finding.evidence || "(none given)"}${finding.suggestedFix ? `\n  - suggested fix: ${finding.suggestedFix}` : ""}${finding.files?.length ? `\n  - files: ${finding.files.join(", ")}` : ""}`,
        )),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(aiReviewDir, "summary.md"), md);

  if (results.length > 0) {
    const primaryModel =
      state.model ??
      results.find(
        (result) =>
          result.status === "reviewed" && result.review.backend?.model,
      )?.review.backend.model;
    const reviewer = { kind: "agent", id: "e2e-ai-review" };
    if (primaryModel) reviewer.model = primaryModel;
    const certify = {
      schema: 1,
      reviewer,
      verdicts: results.map(toCertifyVerdict),
    };
    fs.writeFileSync(
      path.join(aiReviewDir, "certify-verdicts.json"),
      `${JSON.stringify(certify, null, 2)}\n`,
    );
  }
  return { aiReviewDir, summary };
}

async function applyFixes(state, results) {
  const fixable = rankFindings(results).filter(
    (finding) => finding.suggestedFix && finding.files?.length,
  );
  const aiReviewDir = path.join(runDir(REPO_ROOT, state.runId), "ai-review");
  const logPath = path.join(aiReviewDir, "fixes.log");
  const lines = [
    `# AI review fixes — run ${state.runId} — ${new Date().toISOString()}`,
    "",
  ];
  if (fixable.length === 0) {
    lines.push(
      "No findings carried both a suggestedFix and target files; nothing attempted.",
    );
    fs.writeFileSync(logPath, `${lines.join("\n")}\n`);
    console.log("[ai-review] --fix: no actionable findings");
    return;
  }
  for (const finding of fixable) {
    const fixPrompt = [
      `Apply this ONE fix in the repository at ${REPO_ROOT}. Modify ONLY these files: ${finding.files.join(", ")}.`,
      `Do NOT run git commit, git add, or touch any other file.`,
      "",
      `Finding (${finding.severity}, area: ${finding.area}, from e2e test ${finding.testId}):`,
      `summary: ${finding.summary}`,
      `evidence: ${finding.evidence}`,
      `suggested fix: ${finding.suggestedFix}`,
    ].join("\n");
    lines.push(
      `## ${finding.severity} — ${finding.summary}`,
      `files: ${finding.files.join(", ")}`,
    );
    try {
      const invocation = await invokeReviewer(state, {
        prompt: fixPrompt,
        write: true,
      });
      lines.push(
        `backend: ${invocation.backend} (${invocation.durationMs}ms)`,
        "output tail:",
        invocation.stdout.slice(-2000),
      );
    } catch (error) {
      // error-policy:J4 a failed fix attempt is recorded in fixes.log and on
      // the console; remaining fixes still run and nothing is fabricated.
      lines.push(`fix invocation FAILED: ${error.message}`);
      console.warn(
        `[ai-review] --fix failed for "${finding.summary}": ${error.message}`,
      );
    }
    const diffStat = execFileSync("git", ["diff", "--stat"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    lines.push(
      "",
      "git diff --stat after this fix:",
      diffStat || "(working tree clean)",
      "",
    );
  }
  fs.writeFileSync(logPath, `${lines.join("\n")}\n`);
  console.log(`[ai-review] --fix log: ${logPath} (nothing was committed)`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const runId = args.run ?? latestRunId(REPO_ROOT);
  if (!runId) {
    throw new Error(
      "no e2e run found — pass --run <id> or produce one under <repo>/e2e (see scripts/e2e-artifacts/contract.mjs)",
    );
  }
  const index = buildRunIndex(REPO_ROOT, runId);
  if (index.testCount === 0) {
    throw new Error(`run ${runId} contains no test manifests`);
  }
  let selected = index.tests;
  if (args.only) {
    selected = selected.filter(
      (entry) =>
        entry.id.includes(args.only) || (entry.title ?? "").includes(args.only),
    );
    if (selected.length === 0) {
      throw new Error(`--only "${args.only}" matched no tests in run ${runId}`);
    }
  }
  if (selected.length > args.maxTests)
    selected = selected.slice(0, args.maxTests);

  const overrideCmd = process.env.ELIZA_AI_REVIEW_CMD;
  const detected = detectBackends();
  if (!overrideCmd) {
    const usable = pickBackend({
      preference: args.backend,
      detected,
      model: args.model,
    });
    if (!usable) {
      throw new Error(
        `no reviewer CLI available for --backend ${args.backend} (detected: codex=${detected.codex ?? "no"}, claude=${detected.claude ?? "no"})`,
      );
    }
  }
  const state = {
    runId,
    preference: args.backend,
    model: args.model,
    detected,
    excluded: new Set(),
    overrideCmd,
    backendUsage: {},
  };

  console.log(
    `[ai-review] run=${runId} tests=${selected.length}/${index.testCount} jobs=${args.jobs} backend=${overrideCmd ? "override (ELIZA_AI_REVIEW_CMD)" : args.backend}`,
  );

  const results = await runPool(selected, args.jobs, async (entry) => {
    const result = await reviewOneTest(state, entry);
    if (result.status === "skipped") {
      console.log(`[ai-review] SKIP ${entry.id}: ${result.reason}`);
    } else {
      console.log(
        `[ai-review] ${result.review.verdict.toUpperCase()} ${entry.id} (confidence ${result.review.confidence}, ${result.review.findings.length} finding(s), ${result.review.backend?.name})`,
      );
    }
    return result;
  });

  const { aiReviewDir, summary } = writeSummaries(state, results);
  console.log(`[ai-review] summary: ${path.join(aiReviewDir, "summary.json")}`);
  console.log(
    `[ai-review] verdicts: pass=${summary.perVerdict.pass} fail=${summary.perVerdict.fail} flaky=${summary.perVerdict.flaky} needs-eyeball=${summary.perVerdict["needs-eyeball"]} skipped=${summary.perVerdict.skipped}`,
  );

  if (args.fix) {
    await applyFixes(state, results);
  }

  const failed = summary.perVerdict.fail > 0;
  process.exitCode = failed ? 1 : 0;
}

// error-policy:J1 process boundary: any error becomes a nonzero exit with the
// message on stderr; there is no caller above this to rethrow to.
main().catch((error) => {
  console.error(`[ai-review] fatal: ${error.message}`);
  process.exitCode = 2;
});
