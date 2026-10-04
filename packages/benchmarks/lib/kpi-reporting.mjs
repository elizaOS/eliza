/** Shared persistence for benchmark KPI producers. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

export function createKpiReporter(producer, suiteDirectory, options = {}) {
  const repoRoot =
    options.repoRoot === undefined
      ? process.env.ELIZA_REPO_DIR?.trim()
      : options.repoRoot;
  if (!repoRoot && options.repoRoot === undefined)
    throw new Error(
      `[${producer}] Set ELIZA_REPO_DIR to the checkout being measured.`,
    );
  const resultsRoot =
    process.env.BENCHMARK_OUTPUT_ROOT || testOutputPath(producer);
  function gitInfo() {
    if (!repoRoot)
      return options.recordKey === "workload"
        ? null
        : { branch: null, commit: null, dirty: null };
    const run = (args) => {
      try {
        return execFileSync("git", args, {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        return null;
      }
    };
    const status = run(["status", "--porcelain"]);
    return {
      branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
      commit: run(["rev-parse", "HEAD"]),
      dirty: status === null ? null : status.length > 0,
    };
  }
  function writeAtomic(file, text) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { flag: "wx" });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  function recordResult(kpi, payload, nowIso) {
    const directory = join(resultsRoot, kpi);
    mkdirSync(directory, { recursive: true });
    const record = {
      ...payload,
      [options.recordKey || "kpi"]: kpi,
      recordedAt: nowIso,
      git: gitInfo(),
    };
    const file = join(directory, `${nowIso.replace(/[:.]/g, "-")}.json`);
    const text = JSON.stringify(record, null, 2);
    writeAtomic(file, text);
    writeAtomic(join(directory, "latest.json"), text);
    return {
      file: options.returnLatest ? join(directory, "latest.json") : file,
      record,
    };
  }
  function readLatest(kpi) {
    try {
      return JSON.parse(
        readFileSync(join(resultsRoot, kpi, "latest.json"), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  function loadBudgets() {
    return JSON.parse(
      readFileSync(join(suiteDirectory, "budgets.json"), "utf8"),
    );
  }
  return {
    REPO_ROOT: repoRoot,
    RESULTS_ROOT: resultsRoot,
    gitInfo,
    recordResult,
    readLatest,
    loadBudgets,
  };
}

export function ms(value) {
  return value == null ? "—" : `${Math.round(value)} ms`;
}
