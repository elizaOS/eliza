#!/usr/bin/env node
/**
 * omnivoice-smoke.mjs — passive end-to-end wiring check.
 *
 * Verifies the OmniVoice stack is plumbed together without loading any
 * native library, importing the plugin, or invoking a model. Every
 * filesystem call is read-only existsSync / statSync; no network. Safe
 * to run on a fresh checkout that has not had `bun install` yet.
 *
 * Exit codes:
 *   0 — all wiring present (lib + GGUFs may still need to be fetched,
 *       that is expected; the script reports them as "not staged" but
 *       does not fail).
 *   1 — wiring broken: a plugin source file, workflow, or conversion
 *       script that should be in the tree is missing.
 *   2 — partial: optional path component missing in a way that an
 *       end-user would care about (e.g. plugin source intact but
 *       conversion script's --dry-run errored).
 *
 * Flags:
 *   --help, -h     Show this help and exit 0.
 *   --json         Emit one JSON object on stdout (machine-readable).
 *   --verbose, -v  Print full per-step details, not just the summary.
 *
 * IMPORTANT: This script must remain pure Node.js stdlib — no top-level
 * imports of @elizaos/core or @elizaos/plugin-omnivoice. The point is
 * that a freshly cloned repo (no `bun install`) can still run this and
 * get a usable answer.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Resolve repo root from this file's location:
//   scripts/inference/omnivoice-smoke.mjs  ->  <repo>/
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

const HELP = `omnivoice-smoke.mjs — passive end-to-end wiring check.

Usage:
  node scripts/inference/omnivoice-smoke.mjs [options]

Options:
  -h, --help       Show this help and exit.
  --json           Emit machine-readable JSON instead of a human summary.
  -v, --verbose    Print per-step details in human mode.

Exit codes:
  0   all wiring present
  1   wiring broken (a tracked source file is missing)
  2   partial (e.g. dry-run plan emitted a non-zero exit code)

This script never loads libomnivoice and never imports plugin-omnivoice.
It is safe to run on a fresh clone with no dependencies installed.
`;

function parseArgs(argv) {
  const args = { help: false, json: false, verbose: false };
  for (const a of argv) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--json") args.json = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else {
      process.stderr.write(`omnivoice-smoke: unknown flag: ${a}\n`);
      process.stderr.write(HELP);
      process.exit(2);
    }
  }
  return args;
}

function resolveStateDir() {
  const env =
    process.env.MILADY_STATE_DIR ??
    process.env.ELIZA_STATE_DIR ??
    undefined;
  if (typeof env === "string" && env.length > 0) return env;
  return path.join(homedir(), ".milady");
}

// ─── Step 1: native library on disk ──────────────────────────────────
function checkLibrary() {
  const envOverride = process.env.OMNIVOICE_LIB_PATH;
  const stateDir = resolveStateDir();
  const candidates = [];

  if (typeof envOverride === "string" && envOverride.length > 0) {
    candidates.push({ path: envOverride, source: "OMNIVOICE_LIB_PATH" });
  }

  // Conventional drop-in locations (kept loose — we just look, we don't
  // open). These mirror what plugin-omnivoice/src/ffi.ts probes.
  const platformNames =
    process.platform === "darwin"
      ? ["libomnivoice.dylib"]
      : process.platform === "win32"
        ? ["libomnivoice.dll", "omnivoice.dll"]
        : ["libomnivoice.so"];

  for (const name of platformNames) {
    candidates.push({
      path: path.join(stateDir, "lib", name),
      source: "state-dir/lib",
    });
    candidates.push({
      path: path.join(REPO_ROOT, "packages", "inference", "build", name),
      source: "packages/inference/build",
    });
    candidates.push({
      path: path.join(
        REPO_ROOT,
        "packages",
        "inference",
        "omnivoice.cpp",
        "build",
        name,
      ),
      source: "omnivoice.cpp/build",
    });
    candidates.push({
      path: path.join(
        REPO_ROOT,
        "packages",
        "inference",
        "llama.cpp",
        "build",
        "bin",
        name,
      ),
      source: "llama.cpp/build/bin",
    });
  }

  const found = candidates.find((c) => existsSync(c.path));
  if (found) {
    return {
      step: "library",
      ok: true,
      staged: true,
      path: found.path,
      source: found.source,
      detail: "libomnivoice located",
    };
  }

  return {
    step: "library",
    ok: true, // NOT a wiring failure — the lib is operator-provided
    staged: false,
    path: null,
    detail:
      "libomnivoice not on disk (operator must build or download — see docs/inference/omnivoice-binaries.md)",
    searched: candidates.map((c) => c.path),
  };
}

// ─── Step 2: GGUF model pairs ────────────────────────────────────────
function classifyGguf(name) {
  const lower = name.toLowerCase();
  if (!lower.endsWith(".gguf")) return null;
  if (lower.includes("tokenizer") || lower.includes("codec")) return "codec";
  if (lower.includes("base") || lower.includes("model")) return "model";
  return null;
}

function checkVariantModels(variant) {
  const stateDir = resolveStateDir();
  const dir = path.join(stateDir, "models", "omnivoice", variant);
  if (!existsSync(dir)) {
    return { variant, dir, staged: false, reason: "directory missing" };
  }
  let entries;
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) {
      return { variant, dir, staged: false, reason: "not a directory" };
    }
    entries = readdirSync(dir);
  } catch (err) {
    return {
      variant,
      dir,
      staged: false,
      reason: `cannot read: ${err && err.message ? err.message : String(err)}`,
    };
  }

  const ggufs = entries.filter((n) => n.toLowerCase().endsWith(".gguf"));
  let modelFile = null;
  let codecFile = null;
  for (const name of [...ggufs].sort().reverse()) {
    const role = classifyGguf(name);
    if (role === "model" && !modelFile) modelFile = name;
    else if (role === "codec" && !codecFile) codecFile = name;
  }
  return {
    variant,
    dir,
    staged: Boolean(modelFile && codecFile),
    modelFile,
    codecFile,
    ggufs,
  };
}

function checkModels() {
  const speech = checkVariantModels("speech");
  const singing = checkVariantModels("singing");
  return {
    step: "models",
    ok: true, // model staging is operator territory; absence is informational
    speech,
    singing,
    detail: `speech=${speech.staged ? "staged" : "missing"} singing=${singing.staged ? "staged" : "missing"}`,
  };
}

// ─── Step 3: plugin source files present ─────────────────────────────
function checkPluginSources() {
  const pluginDir = path.join(REPO_ROOT, "plugins", "plugin-omnivoice");
  const required = [
    "package.json",
    path.join("src", "index.ts"),
    path.join("src", "ffi.ts"),
    path.join("src", "discover.ts"),
    path.join("src", "shutdown.ts"),
    path.join("src", "synth.ts"),
    path.join("src", "singing.ts"),
    path.join("src", "errors.ts"),
    path.join("src", "types.ts"),
  ];
  const missing = [];
  const present = [];
  for (const rel of required) {
    const abs = path.join(pluginDir, rel);
    if (existsSync(abs)) present.push(rel);
    else missing.push(rel);
  }
  return {
    step: "plugin-sources",
    ok: missing.length === 0,
    pluginDir,
    present,
    missing,
    detail:
      missing.length === 0
        ? `all ${required.length} plugin source files present`
        : `${missing.length} plugin source file(s) missing`,
  };
}

// ─── Step 4: CI workflows ────────────────────────────────────────────
function checkWorkflows() {
  const workflowDir = path.join(REPO_ROOT, ".github", "workflows");
  const required = ["build-omnivoice.yml", "convert-omnivoice-singing.yml"];
  const missing = [];
  const present = [];
  for (const name of required) {
    const abs = path.join(workflowDir, name);
    if (existsSync(abs)) present.push(name);
    else missing.push(name);
  }
  return {
    step: "workflows",
    ok: missing.length === 0,
    workflowDir,
    present,
    missing,
    detail:
      missing.length === 0
        ? "build + convert workflows present"
        : `${missing.length} workflow file(s) missing`,
  };
}

// ─── Step 5: dry-run the conversion planner ──────────────────────────
function checkConvertDryRun() {
  const script = path.join(
    REPO_ROOT,
    "scripts",
    "inference",
    "convert-omnivoice-singing.mjs",
  );
  if (!existsSync(script)) {
    return {
      step: "convert-dry-run",
      ok: false,
      script,
      detail: "convert-omnivoice-singing.mjs missing",
    };
  }
  const tmpOut = path.join(
    process.env.TMPDIR || "/tmp",
    "omnivoice-smoke-out",
  );
  // The script is a planner; --dry-run is documented to print the plan
  // without downloading or converting (see script header). We capture
  // the exit code and a small slice of stderr for visibility.
  let exitCode = -1;
  let stderr = "";
  let stdout = "";
  try {
    const out = execFileSync(
      process.execPath,
      [script, "--dry-run", "--out-dir", tmpOut],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    exitCode = 0;
    stdout = out;
  } catch (err) {
    exitCode =
      typeof err.status === "number"
        ? err.status
        : err && err.code === "ENOENT"
          ? 127
          : 1;
    stdout = err && err.stdout ? String(err.stdout) : "";
    stderr = err && err.stderr ? String(err.stderr) : "";
  }
  return {
    step: "convert-dry-run",
    ok: exitCode === 0,
    script,
    exitCode,
    tmpOut,
    // Trim noisy log lines for the human summary; full text preserved
    // in JSON output.
    stderrTail: stderr.split("\n").slice(-6).join("\n"),
    stdoutTail: stdout.split("\n").slice(-6).join("\n"),
    detail:
      exitCode === 0
        ? "dry-run planner exited cleanly"
        : `dry-run planner exited ${exitCode}`,
  };
}

// ─── Orchestration ───────────────────────────────────────────────────
function runChecks() {
  return {
    library: checkLibrary(),
    models: checkModels(),
    pluginSources: checkPluginSources(),
    workflows: checkWorkflows(),
    convertDryRun: checkConvertDryRun(),
  };
}

function summarize(results) {
  // Wiring failures (exit 1): tracked-in-tree files missing.
  const wiringBroken =
    !results.pluginSources.ok ||
    !results.workflows.ok ||
    results.convertDryRun.script === undefined ||
    !existsSync(results.convertDryRun.script);

  // Partial (exit 2): the dry-run planner exited non-zero.
  const partial = !results.convertDryRun.ok && !wiringBroken;

  let exitCode = 0;
  if (wiringBroken) exitCode = 1;
  else if (partial) exitCode = 2;

  return { exitCode, wiringBroken, partial };
}

function renderHuman(results, verdict, verbose) {
  const lines = [];
  lines.push("omnivoice-smoke — passive wiring check");
  lines.push("");
  lines.push(
    `[1/5] libomnivoice on disk:    ${
      results.library.staged ? "FOUND" : "not staged"
    }`,
  );
  if (results.library.staged) {
    lines.push(
      `      path:                    ${results.library.path} (${results.library.source})`,
    );
  } else if (verbose) {
    lines.push("      searched:");
    for (const p of results.library.searched) lines.push(`        - ${p}`);
  }

  const sp = results.models.speech;
  const sg = results.models.singing;
  lines.push(
    `[2/5] GGUFs (speech):          ${sp.staged ? "STAGED" : "not staged"}${
      sp.staged ? ` (${sp.modelFile} + ${sp.codecFile})` : ""
    }`,
  );
  if (verbose && !sp.staged) {
    lines.push(`      dir:                     ${sp.dir} (${sp.reason ?? "incomplete"})`);
  }
  lines.push(
    `      GGUFs (singing):         ${sg.staged ? "STAGED" : "not staged"}${
      sg.staged ? ` (${sg.modelFile} + ${sg.codecFile})` : ""
    }`,
  );
  if (verbose && !sg.staged) {
    lines.push(`      dir:                     ${sg.dir} (${sg.reason ?? "incomplete"})`);
  }

  const ps = results.pluginSources;
  lines.push(
    `[3/5] plugin source files:     ${ps.ok ? "OK" : "MISSING"} (${ps.present.length}/${ps.present.length + ps.missing.length})`,
  );
  if (!ps.ok || verbose) {
    if (ps.missing.length > 0) {
      lines.push("      missing:");
      for (const m of ps.missing) lines.push(`        - ${m}`);
    } else if (verbose) {
      for (const p of ps.present) lines.push(`        + ${p}`);
    }
  }

  const wf = results.workflows;
  lines.push(
    `[4/5] GitHub workflows:        ${wf.ok ? "OK" : "MISSING"} (${wf.present.length}/${wf.present.length + wf.missing.length})`,
  );
  if (!wf.ok || verbose) {
    if (wf.missing.length > 0) {
      lines.push("      missing:");
      for (const m of wf.missing) lines.push(`        - ${m}`);
    } else if (verbose) {
      for (const p of wf.present) lines.push(`        + ${p}`);
    }
  }

  const cd = results.convertDryRun;
  lines.push(
    `[5/5] convert-singing --dry-run: ${cd.ok ? "OK" : `FAILED (exit ${cd.exitCode})`}`,
  );
  if (verbose && cd.stderrTail) {
    lines.push("      stderr (tail):");
    for (const line of cd.stderrTail.split("\n")) {
      if (line.length > 0) lines.push(`        ${line}`);
    }
  }

  lines.push("");
  if (verdict.exitCode === 0) {
    lines.push(
      "RESULT: wiring complete. Operator action remaining: ensure libomnivoice + GGUFs are on disk (see docs/inference/omnivoice-readiness.md).",
    );
  } else if (verdict.exitCode === 2) {
    lines.push("RESULT: partial — wiring intact but dry-run planner did not exit cleanly.");
  } else {
    lines.push("RESULT: wiring BROKEN — a tracked source file is missing. See above.");
  }
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const results = runChecks();
  const verdict = summarize(results);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          exitCode: verdict.exitCode,
          wiringBroken: verdict.wiringBroken,
          partial: verdict.partial,
          repoRoot: REPO_ROOT,
          stateDir: resolveStateDir(),
          platform: process.platform,
          arch: process.arch,
          results,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${renderHuman(results, verdict, args.verbose)}\n`);
  }

  process.exit(verdict.exitCode);
}

main();
