#!/usr/bin/env node
/**
 * Stage 3 — GEPA optimization sweep over the gpt-5.5 harvest.
 *
 * Reads the Stage-2 harvest tree
 * (.github/issue-evidence/gpt55-training-pipeline/harvest/{scenario,benchmark}/…),
 * selects the GEPA-optimizable failures (real agent failures, NOT connector/cred
 * env-gates — decided from `report.json`, never stderr grep), groups them by the
 * plugin-training GEPA task the scorer actually supports, builds one
 * `eliza_native_v1` GEPA dataset per task, emits the exact `train` commands, and
 * (with --run) executes them: GEPA → artifact → re-run the failing scenarios on
 * gpt-5.5-via-Codex → capture the (hopefully now-passing) trajectories back into
 * harvest/scenario/ so Stage 4 picks them up.
 *
 * WHY the dataset for a task contains PASSING (gold) rows, not the failing ones:
 * the native backend deliberately EXCLUDES failed-scenario rows as gold
 * (`native.ts` isFailedScenarioSignal, #8795) — a failure's wrong output must
 * never be optimized *toward*. GEPA optimizes a task's SYSTEM PROMPT against that
 * task's gold (input → expected) rows; the failing scenarios supply the *inputs*
 * the optimized prompt then has to get right, and the confirmation is the re-run.
 * So the per-task GEPA dataset = the passing scenarios' native rows for that task.
 * (The `--baseline` is inferred from the dataset's own system message when not
 * passed; GEPA rewrites that.)
 *
 *   Modes:
 *     --dry-run    (default)  classify + group + build datasets + PRINT commands.
 *     --run                   actually execute GEPA per task (EXPENSIVE — gated).
 *     --run --only <task>     GEPA a single task (the small end-to-end proof).
 *     --rerun-only            skip GEPA; only re-run failing scenarios against an
 *                             already-produced artifact store (--state-dir).
 *
 *   Resumable: per-task dataset + per-task artifact + per-scenario rerun verdict
 *   are all on disk; re-invoking skips completed steps unless --force.
 *
 * NEVER commits, never echoes secrets. Scoring model is Cerebras (fast, sanctioned);
 * the flip *validation* re-run is gpt-5.5-via-Codex (S1 provider env).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const EVIDENCE_ROOT = path.join(
  REPO_ROOT,
  ".github/issue-evidence/gpt55-training-pipeline",
);
const HARVEST_ROOT = path.join(EVIDENCE_ROOT, "harvest");
const TSCONFIG = path.join(REPO_ROOT, "tsconfig.json");
const S1_PROVIDER_PATH = "/tmp/s1-provider-full.json";

// The harvest tree dirs are slug(realDir) (slashes → "_"), which is NOT
// reversible, so rebuild slug → realDir from the manifest to give the rerun the
// real scenario-runner directory. Matches harvest-runner.mjs's slug().
const slugKey = (s) =>
  s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
const SLUG_TO_DIR = (() => {
  const map = {};
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(__dirname, "manifest.json"), "utf8"),
    );
    for (const it of manifest.families?.scenario?.items ?? []) {
      if (it.dir) map[slugKey(it.dir)] = it.dir;
    }
  } catch {
    /* manifest optional — fall back to best-effort un-slug below */
  }
  return map;
})();

// Stage-3 working tree (datasets, artifacts, reruns) — NOT the harvest dirs.
const STAGE3_ROOT = path.join(EVIDENCE_ROOT, "s3-gepa", "sweep");
const DATASET_DIR = path.join(STAGE3_ROOT, "datasets");
const RERUN_DIR = path.join(STAGE3_ROOT, "reruns");
const DEFAULT_STATE_DIR = path.join(STAGE3_ROOT, "state"); // GEPA artifact store

// -------- CLI --------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RUN = flag("--run");
const RERUN_ONLY = flag("--rerun-only");
const DRY_RUN = !RUN && !RERUN_ONLY; // dry-run is the default
const FORCE = flag("--force");
const ONLY_TASK = opt("--only", null);
const STATE_DIR = path.resolve(opt("--state-dir", DEFAULT_STATE_DIR));
const MAX_RERUN = Number(opt("--max-rerun", "0")) || 0; // 0 = all failing scenarios for the task
const SCENARIO_TIMEOUT_MS = Number(opt("--timeout-ms", "300000")) || 300000;
// GEPA optimizes a SHARED prompt — sample the gold pool rather than scoring all
// 300+ full-context rows every candidate. 0 = no cap.
const SAMPLE_ROWS = Number(opt("--sample-rows", "0")) || 0;
const MAX_ROW_CHARS = Number(opt("--max-row-chars", "0")) || 0;

/**
 * native `task_type` (stamped on every harvested row) → GEPA `--task` id.
 * The valid `--task` ids are ALL_TRAJECTORY_TRAINING_TASKS in
 * plugins/plugin-training/src/core/trajectory-task-datasets.ts. `evaluation`
 * rows are EVALUATOR model calls, not a planner prompt task, and there is no
 * `evaluation` GEPA task — they are not GEPA targets (dropped from grouping).
 */
const TASK_TYPE_TO_GEPA_TASK = {
  should_respond: "should_respond",
  context_routing: "context_routing",
  action_planner: "action_planner",
  response: "response",
  media_description: "media_description",
  view_context: "view_context",
  calendar_extract: "calendar_extract",
  schedule_plan: "schedule_plan",
  reminder_dispatch: "reminder_dispatch",
  inbox_triage: "inbox_triage",
  meeting_prep: "meeting_prep",
  morning_brief: "morning_brief",
  health_checkin: "health_checkin",
  screentime_recap: "screentime_recap",
  // evaluation: intentionally omitted — not a GEPA prompt task.
};

// Tasks with a dedicated scorer (else default token-overlap). Informational —
// used to annotate the emitted plan so the operator knows which flips are exact.
const TASKS_WITH_DEDICATED_SCORER = new Set([
  "action_planner",
  "view_context",
  "calendar_extract",
  "schedule_plan",
  "reminder_dispatch",
  "inbox_triage",
  "meeting_prep",
  "morning_brief",
  "health_checkin",
  "screentime_recap",
]);

// ---------------------------------------------------------------------------
// FAILURE CLASSIFIER — report.json only (authoritative), never stderr.
// Mirrors the taxonomy in the harvest evidence: ~58% connector/cred env-gated
// (excluded), ~42% real agent failures (GEPA-optimizable).
// ---------------------------------------------------------------------------

/** Collect every failure `detail` string from a scenario report. */
function failureDetails(report) {
  const out = [];
  for (const s of report.scenarios ?? []) {
    if (s.status !== "failed") continue;
    for (const a of s.failedAssertions ?? []) {
      out.push(typeof a === "string" ? a : String(a?.detail ?? ""));
    }
    for (const t of s.turns ?? []) {
      for (const a of t.failedAssertions ?? []) {
        out.push(typeof a === "string" ? a : String(a?.detail ?? ""));
      }
    }
  }
  return out;
}

const CONNECTOR_CRED_MARKERS = [
  "gmail mock",
  "gmail action",
  "gmail mock request",
  "gmailbatchmodify",
  "gmaildraftcreated",
  "gmailmessagesent",
  "connector dispatch",
  "approval queue",
  "mock request",
  "push sent",
  "no push",
  "messagedelivered",
  "draftexists",
  "interventionrequest",
  "device_intent",
  "source_connector_not_found",
  "connector_not_found",
  "certify",
  "session-revoked",
  "session_revoked",
  "rate-limited",
  "rate_limited",
  "helper-disconnected",
  "disconnected",
  "not currently available",
];

/**
 * Classify a failed scenario from its report + id. Returns one of:
 *   CONNECTOR_CRED   — env-gated (missing connector / credential / mock). EXCLUDE.
 *   ACTION_SELECTION — wrong action chosen / wrong action args. GEPA-optimizable.
 *   JUDGE_BELOW      — response judge score under threshold. GEPA-optimizable.
 *   OUTPUT_FORMAT    — responseIncludes/Excludes / structured-field mismatch. GEPA.
 *   OTHER            — real failure, no clean task mapping. Not GEPA-targeted here.
 */
function classifyFailure(scenarioId, report) {
  const details = failureDetails(report).map((d) => d.toLowerCase());
  const joined = details.join(" || ");
  const idl = scenarioId.toLowerCase();

  // Env-gate wins: connector/certify scenarios are excluded even if they also
  // trip an action assertion (the action fails *because* the connector is gone).
  if (
    idl.includes("connector.") ||
    idl.includes(".certify") ||
    CONNECTOR_CRED_MARKERS.some((m) => joined.includes(m))
  ) {
    return "CONNECTOR_CRED";
  }
  if (
    joined.includes("no selected action") ||
    joined.includes("expectedactions") ||
    joined.includes("selectedactionarguments") ||
    joined.includes("actioncalled") ||
    /expected \d+ call\(s\) to/.test(joined)
  ) {
    return "ACTION_SELECTION";
  }
  if (joined.includes("responsejudge") || /score \d/.test(joined)) {
    return "JUDGE_BELOW";
  }
  if (
    joined.includes("responseincludes") ||
    joined.includes("responseexcludes") ||
    joined.includes("structured argument")
  ) {
    return "OUTPUT_FORMAT";
  }
  return "OTHER";
}

const GEPA_OPTIMIZABLE = new Set([
  "ACTION_SELECTION",
  "JUDGE_BELOW",
  "OUTPUT_FORMAT",
]);

// ---------------------------------------------------------------------------
// Harvest walk
// ---------------------------------------------------------------------------

/** Every item dir under harvest/{scenario,benchmark}/<family>/<item>/. */
function walkHarvestItems() {
  const items = [];
  for (const family of ["scenario", "benchmark"]) {
    const famRoot = path.join(HARVEST_ROOT, family);
    if (!existsSync(famRoot)) continue;
    for (const familyDir of readdirSync(famRoot)) {
      const fdPath = path.join(famRoot, familyDir);
      let children;
      try {
        children = readdirSync(fdPath);
      } catch {
        continue;
      }
      for (const item of children) {
        const itemDir = path.join(fdPath, item);
        const verdictPath = path.join(itemDir, "verdict.json");
        if (!existsSync(verdictPath)) continue;
        items.push({ family, familyDir, item, itemDir, verdictPath });
      }
    }
  }
  return items;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/** Read native.jsonl rows (skip blank/malformed lines). */
function readNativeRows(p) {
  if (!existsSync(p)) return [];
  const rows = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return rows;
}

const rowTaskType = (row) =>
  row?.metadata?.task_type ?? row?.metadata?.taskType ?? null;
const rowScenarioStatus = (row) =>
  row?.scenarioStatus ??
  row?.metadata?.scenario_status ??
  row?.metadata?.scenarioStatus ??
  null;

// ---------------------------------------------------------------------------
// Selection + grouping
// ---------------------------------------------------------------------------

function selectAndGroup() {
  const items = walkHarvestItems();
  // Per-GEPA-task accumulation.
  const perTask = {}; // task -> { goldRows:[], failingScenarios:[{item,dir,itemDir,cat}] }
  const stats = {
    itemsScanned: items.length,
    passed: 0,
    failed: 0,
    error: 0,
    other: 0,
    failClassCounts: {},
    excludedConnectorCred: 0,
  };
  const ensureTask = (task) =>
    (perTask[task] ??= { goldRows: [], failingScenarios: [] });

  for (const it of items) {
    let verdict;
    try {
      verdict = readJson(it.verdictPath);
    } catch {
      stats.error += 1;
      continue;
    }
    const status = verdict.status;
    if (status === "passed") {
      stats.passed += 1;
      // Gold rows: every passing native row buckets into its GEPA task.
      for (const row of readNativeRows(it.itemDir + "/native.jsonl")) {
        if (rowScenarioStatus(row) === "failed") continue; // belt + suspenders
        const gepaTask = TASK_TYPE_TO_GEPA_TASK[rowTaskType(row)];
        if (!gepaTask) continue;
        ensureTask(gepaTask).goldRows.push(row);
      }
      continue;
    }
    if (status !== "failed") {
      stats.other += 1;
      continue;
    }
    stats.failed += 1;

    const reportPath = it.itemDir + "/report.json";
    if (!existsSync(reportPath)) {
      stats.failClassCounts.NO_REPORT = (stats.failClassCounts.NO_REPORT ?? 0) + 1;
      continue;
    }
    let report;
    try {
      report = readJson(reportPath);
    } catch {
      stats.failClassCounts.BAD_REPORT =
        (stats.failClassCounts.BAD_REPORT ?? 0) + 1;
      continue;
    }
    const cat = classifyFailure(it.item, report);
    stats.failClassCounts[cat] = (stats.failClassCounts[cat] ?? 0) + 1;
    if (cat === "CONNECTOR_CRED") {
      stats.excludedConnectorCred += 1;
      continue;
    }
    if (!GEPA_OPTIMIZABLE.has(cat)) continue; // OTHER etc — not GEPA-targeted

    // Which GEPA task does this failure implicate? Use the failing scenario's
    // OWN native rows' task_type (already stamped), preferring the task whose
    // failure category matches: ACTION_SELECTION → action_planner, else the
    // dominant non-evaluation task_type present.
    const failRows = readNativeRows(it.itemDir + "/native.jsonl");
    const taskTypesPresent = new Set(
      failRows.map(rowTaskType).filter((t) => TASK_TYPE_TO_GEPA_TASK[t]),
    );
    let targetTask = null;
    if (cat === "ACTION_SELECTION" && taskTypesPresent.has("action_planner")) {
      targetTask = "action_planner";
    } else if (taskTypesPresent.has("action_planner")) {
      targetTask = "action_planner";
    } else if (taskTypesPresent.has("should_respond")) {
      targetTask = "should_respond";
    } else {
      // first LifeOps/other mapped task present
      for (const tt of taskTypesPresent) {
        targetTask = TASK_TYPE_TO_GEPA_TASK[tt];
        if (targetTask) break;
      }
    }
    if (!targetTask) continue;
    ensureTask(targetTask).failingScenarios.push({
      item: it.item,
      familyDir: it.familyDir,
      itemDir: it.itemDir,
      cat,
    });
  }
  return { perTask, stats };
}

/**
 * Slim a harvested request down to ONLY the fields the native backend + GEPA
 * scorer actually consume, so the GEPA dataset fits under the Cerebras
 * queue/TPM ceilings instead of shipping 96K-600K-char rows.
 *
 * WHAT THE PIPELINE READS (verified against native.ts rowToExample + the
 * scorers in scoring.ts): `request.system`, `request.prompt`, and
 * `request.messages` filtered to system/user/assistant roles. The scorer then
 * composes only `system + "\n\n" + user` and runs it through the model; the
 * expected output comes from `response.text` / `response.toolCalls`.
 *
 * WHAT IS PURE DEAD WEIGHT (never read, but dominates row size):
 *   - `request.tools` — the full 38-53-tool catalog serialized per row
 *     (~260K chars on the big action_planner rows). should_respond is a binary
 *     respond/ignore decision that needs no tool schemas at all; action_planner
 *     is scored on the ACTION NAME extracted from the model's text output, not
 *     on re-issuing the tool schema.
 *   - `request.toolChoice`, `request.providerOptions` (~31K chars on the big
 *     should_respond rows) — transport knobs the scorer never sees.
 *   - `tool`-role and other non-{system,user,assistant} messages — the
 *     multi-turn tool-result transcript the parser skips.
 *
 * Dropping these does NOT change any score (the scorer's model input is
 * identical) — it just removes the tokens that saturate the rate limits.
 */
const SCORED_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);
function slimRequest(req) {
  const slim = {};
  if (typeof req.system === "string" && req.system.length > 0) {
    slim.system = req.system;
  }
  if (typeof req.prompt === "string" && req.prompt.trim()) {
    slim.prompt = req.prompt;
  }
  if (Array.isArray(req.messages)) {
    slim.messages = req.messages
      .filter((m) => m && SCORED_MESSAGE_ROLES.has(m.role))
      .map((m) => ({ role: m.role, content: m.content }));
  }
  return slim;
}

/**
 * Build the per-task GEPA dataset: PASSING (gold) native rows for that task,
 * written in the exact `eliza_native_v1` shape the native backend parses. The
 * request is slimmed (see slimRequest) to the fields the parser + scorer read,
 * keeping metadata so the failed-scenario quality guard stays live.
 */
function buildTaskDataset(task, goldRows) {
  mkdirSync(DATASET_DIR, { recursive: true });
  const outPath = path.join(DATASET_DIR, `${task}.gepa.jsonl`);
  const seen = new Set();
  const lines = [];
  for (const row of goldRows) {
    if (row.boundary !== "vercel_ai_sdk.generateText" &&
        row.boundary !== "vercel_ai_sdk.streamText") continue;
    const req = row.request ?? {};
    const resp = row.response ?? {};
    // Must have a usable user turn + expected output (mirrors rowToExample).
    const hasUser =
      (Array.isArray(req.messages) &&
        req.messages.some((m) => m.role === "user" && (m.content ?? "").trim())) ||
      (typeof req.prompt === "string" && req.prompt.trim());
    const hasExpected =
      (typeof resp.text === "string" && resp.text.trim()) ||
      (Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0);
    if (!hasUser || !hasExpected) continue;
    const rec = {
      format: "eliza_native_v1",
      schemaVersion: row.schemaVersion ?? 1,
      boundary: row.boundary,
      request: slimRequest(req),
      response: resp,
      metadata: row.metadata ?? {},
    };
    const key = JSON.stringify([req.messages ?? req.prompt, resp.text ?? resp.toolCalls]);
    if (seen.has(key)) continue; // dedup identical gold rows
    seen.add(key);
    lines.push(JSON.stringify(rec));
  }
  // --sample-rows N + --max-row-chars C : GEPA optimizes a SHARED prompt, so a
  // size-filtered diverse sample gives the signal without blowing the Cerebras
  // TPM on 189K-char full-tool-catalog rows. Drop oversized rows first (they
  // exceed the model context / dominate the token budget), then take an evenly
  // spaced diverse sample.
  let kept = lines;
  if (MAX_ROW_CHARS > 0) kept = kept.filter((l) => l.length <= MAX_ROW_CHARS);
  if (SAMPLE_ROWS > 0 && kept.length > SAMPLE_ROWS) {
    const n = kept.length;
    kept = Array.from({ length: SAMPLE_ROWS }, (_, i) => kept[Math.floor((i * n) / SAMPLE_ROWS)]);
  }
  writeFileSync(outPath, kept.join("\n") + (kept.length ? "\n" : ""));
  return { path: outPath, size: kept.length, poolSize: lines.length };
}

/** The exact `train` command for a task (as an argv array + a printable line). */
function gepaCommand(task, datasetPath) {
  const rel = path.relative(REPO_ROOT, datasetPath);
  const printable =
    `TRAIN_MODEL_PROVIDER=cerebras CEREBRAS_API_KEY=<key> ELIZA_STATE_DIR=${STATE_DIR} \\\n` +
    `  bun run --cwd plugins/plugin-training train -- \\\n` +
    `    --backend native --optimizer gepa --task ${task} \\\n` +
    `    --dataset ${rel}`;
  // baseline is inferred from the dataset's system message when --baseline omitted.
  const argvArr = [
    "run",
    "--cwd",
    "plugins/plugin-training",
    "train",
    "--",
    "--backend",
    "native",
    "--optimizer",
    "gepa",
    "--task",
    task,
    "--dataset",
    datasetPath,
  ];
  return { printable, argvArr };
}

// ---------------------------------------------------------------------------
// Execution (gated behind --run)
// ---------------------------------------------------------------------------

function loadS1ProviderEnv() {
  if (!existsSync(S1_PROVIDER_PATH)) {
    throw new Error(
      `S1 provider env not found at ${S1_PROVIDER_PATH} (needed for the gpt-5.5 re-run). ` +
        `Provide it or export ELIZA_CHAT_VIA_CLI=codex ELIZA_CLI_CODEX_MODEL=gpt-5.5.`,
    );
  }
  return readJson(S1_PROVIDER_PATH);
}

function runGepaForTask(task, datasetPath) {
  const { argvArr } = gepaCommand(task, datasetPath);
  const artifactCurrent = path.join(
    STATE_DIR,
    "optimized-prompts",
    task === "context_routing" ? "should_respond" : task,
    "current",
  );
  if (!FORCE && existsSync(artifactCurrent)) {
    console.log(`[gepa] ${task}: artifact exists, skip (use --force). ${artifactCurrent}`);
    return { task, skipped: true, artifactCurrent };
  }
  if (!process.env.CEREBRAS_API_KEY) {
    throw new Error(
      "CEREBRAS_API_KEY is required to run GEPA scoring (the sanctioned fast eval adapter).",
    );
  }
  console.log(`[gepa] ${task}: running GEPA (dataset=${path.basename(datasetPath)})…`);
  const res = spawnSync("bun", argvArr, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30 * 60 * 1000,
    env: {
      ...process.env,
      TRAIN_MODEL_PROVIDER: "cerebras",
      ELIZA_STATE_DIR: STATE_DIR,
    },
  });
  const logDir = path.join(STAGE3_ROOT, "gepa-logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, `${task}.stdout.log`), res.stdout ?? "");
  writeFileSync(path.join(logDir, `${task}.stderr.log`), res.stderr ?? "");
  return {
    task,
    exitCode: res.status,
    artifactCurrent,
    artifactExists: existsSync(artifactCurrent),
  };
}

/** Re-run one failing scenario with the GEPA artifact loaded, capture flip. */
function rerunScenario(scn, providerEnv) {
  // Real scenario-runner dir from the manifest slug map (the slug is not
  // reversible by string replace; the old __→/ heuristic produced a bogus path
  // like "packages_test_scenarios" → ENOENT, which errored every rerun).
  const dirRel =
    SLUG_TO_DIR[scn.familyDir] ?? scn.familyDir.replace(/__/g, "/");
  const outDir = path.join(RERUN_DIR, scn.familyDir, scn.item);
  mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  const runDir = path.join(outDir, "run");
  const nativePath = path.join(outDir, "native.jsonl");
  const verdictPath = path.join(outDir, "rerun-verdict.json");
  if (!FORCE && existsSync(verdictPath)) {
    return { ...readJson(verdictPath), resumed: true };
  }
  const args = [
    "--conditions",
    "eliza-source",
    "--tsconfig-override",
    TSCONFIG,
    path.join(REPO_ROOT, "packages/scenario-runner/src/cli.ts"),
    "run",
    dirRel,
    "--scenario",
    scn.item,
    "--report",
    reportPath,
    "--run-dir",
    runDir,
    "--export-native",
    nativePath,
  ];
  const res = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: SCENARIO_TIMEOUT_MS,
    env: {
      ...process.env,
      ...providerEnv,
      ELIZA_STATE_DIR: STATE_DIR, // <-- loads the GEPA artifact at boot
      ELIZA_SAVE_TRAJECTORIES: "1",
    },
  });
  writeFileSync(path.join(outDir, "stdout.log"), res.stdout ?? "");
  writeFileSync(path.join(outDir, "stderr.log"), res.stderr ?? "");
  let status = "error";
  let judgeScore = null;
  if (existsSync(reportPath)) {
    try {
      const report = readJson(reportPath);
      const sc =
        (report.scenarios ?? []).find((x) => x.id === scn.item) ??
        report.scenarios?.[0];
      if (sc) {
        status = sc.status ?? "error";
        if (typeof sc.judgeScore === "number") judgeScore = sc.judgeScore;
      }
    } catch {
      /* leave error */
    }
  }
  const flipped = status === "passed";
  const verdict = {
    item: scn.item,
    dir: dirRel,
    cat: scn.cat,
    exitCode: res.status,
    status,
    judgeScore,
    flipped,
    nativePath: existsSync(nativePath) ? nativePath : null,
  };
  writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));

  // On a flip, copy the now-passing trajectory INTO harvest/scenario/ so Stage 4
  // picks it up (additive: a distinct <item>__gepa dir; never overwrites the
  // original failing capture).
  if (flipped && existsSync(nativePath)) {
    const harvestDest = path.join(
      HARVEST_ROOT,
      "scenario",
      scn.familyDir,
      `${scn.item}__gepa`,
    );
    mkdirSync(harvestDest, { recursive: true });
    writeFileSync(
      path.join(harvestDest, "native.jsonl"),
      readFileSync(nativePath, "utf8"),
    );
    if (existsSync(reportPath)) {
      writeFileSync(
        path.join(harvestDest, "report.json"),
        readFileSync(reportPath, "utf8"),
      );
    }
    writeFileSync(
      path.join(harvestDest, "verdict.json"),
      JSON.stringify(
        {
          item: scn.item,
          dir: dirRel,
          status: "passed",
          rows: readNativeRows(nativePath).length,
          judgeScore,
          source: "stage3-gepa-flip",
          nativePath: path.join(harvestDest, "native.jsonl"),
        },
        null,
        2,
      ),
    );
    verdict.harvestDest = harvestDest;
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(STAGE3_ROOT, { recursive: true });
  const { perTask, stats } = selectAndGroup();

  // Build datasets + plan for every task that has BOTH failing scenarios AND gold.
  const plan = [];
  for (const [task, bucket] of Object.entries(perTask)) {
    if (ONLY_TASK && task !== ONLY_TASK) continue;
    const ds = buildTaskDataset(task, bucket.goldRows);
    const cmd = gepaCommand(task, ds.path);
    plan.push({
      task,
      goldRows: bucket.goldRows.length,
      datasetSize: ds.size,
      datasetPath: ds.path,
      failingScenarios: bucket.failingScenarios.length,
      dedicatedScorer: TASKS_WITH_DEDICATED_SCORER.has(task),
      command: cmd.printable,
      _argv: cmd.argvArr,
      _failing: bucket.failingScenarios,
    });
  }
  // Sort: tasks with the most failing scenarios first (highest impact).
  plan.sort((a, b) => b.failingScenarios - a.failingScenarios);

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? "dry-run" : RERUN_ONLY ? "rerun-only" : "run",
    stateDir: STATE_DIR,
    stats,
    tasks: plan.map((p) => ({
      task: p.task,
      goldRows: p.goldRows,
      datasetSize: p.datasetSize,
      failingScenarios: p.failingScenarios,
      dedicatedScorer: p.dedicatedScorer,
      datasetPath: path.relative(REPO_ROOT, p.datasetPath),
    })),
  };

  // ---- DRY RUN: print the plan + commands, stop. ----
  if (DRY_RUN) {
    console.log("=== STAGE 3 GEPA SWEEP — DRY RUN ===\n");
    console.log("Harvest scan:", JSON.stringify(stats, null, 2), "\n");
    console.log("Per-task GEPA plan (highest impact first):\n");
    for (const p of plan) {
      const gepaable = p.datasetSize > 0 && p.failingScenarios > 0;
      console.log(
        `  task=${p.task}  gold=${p.goldRows}→dataset=${p.datasetSize}  ` +
          `failingScenarios=${p.failingScenarios}  ` +
          `scorer=${p.dedicatedScorer ? "dedicated" : "token-overlap"}  ` +
          `${gepaable ? "RUNNABLE" : "SKIP(no dataset or no failures)"}`,
      );
      if (gepaable) console.log(p.command + "\n");
    }
    const summaryPath = path.join(STAGE3_ROOT, "stage3-plan.json");
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`\nplan → ${path.relative(REPO_ROOT, summaryPath)}`);
    console.log(
      "\nNo GEPA executed. To run ONE task end-to-end (proof):\n" +
        `  CEREBRAS_API_KEY=<key> node scripts/training-harvest/stage3-gepa-sweep.mjs --run --only action_planner --max-rerun 1`,
    );
    return;
  }

  // ---- RUN / RERUN-ONLY ----
  const providerEnv = loadS1ProviderEnv();
  const results = [];
  for (const p of plan) {
    if (p.datasetSize === 0 || p.failingScenarios === 0) {
      console.log(`[skip] ${p.task}: dataset=${p.datasetSize} failing=${p.failingScenarios}`);
      continue;
    }
    let gepaResult = { task: p.task, skipped: RERUN_ONLY };
    if (!RERUN_ONLY) {
      gepaResult = runGepaForTask(p.task, p.datasetPath);
      if (gepaResult.exitCode && gepaResult.exitCode !== 0) {
        console.log(`[gepa] ${p.task}: exit=${gepaResult.exitCode} — see gepa-logs; skipping rerun.`);
        results.push({ task: p.task, gepaResult, reruns: [] });
        continue;
      }
    }
    // Re-run the failing scenarios for this task with the artifact loaded.
    const failing = MAX_RERUN ? p._failing.slice(0, MAX_RERUN) : p._failing;
    const reruns = [];
    for (const scn of failing) {
      console.log(`[rerun] ${p.task} :: ${scn.item} (was ${scn.cat})`);
      const v = rerunScenario(scn, providerEnv);
      console.log(`[rerun]   → status=${v.status} flipped=${v.flipped} judge=${v.judgeScore ?? "n/a"}`);
      reruns.push(v);
    }
    const flips = reruns.filter((r) => r.flipped).length;
    results.push({
      task: p.task,
      gepaResult,
      reruns,
      flips,
      rerunCount: reruns.length,
    });
    console.log(`[task] ${p.task}: ${flips}/${reruns.length} flipped to passing\n`);
  }
  summary.results = results;
  const summaryPath = path.join(
    STAGE3_ROOT,
    `stage3-run-${Date.now()}.json`,
  );
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\nrun summary → ${path.relative(REPO_ROOT, summaryPath)}`);
}

main();
