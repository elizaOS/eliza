/**
 * Best-of-N test harness for LLM-driven tests.
 *
 * The LLM-routed tests in this repo are inherently stochastic — given the same
 * prompt an LLM may route slightly differently run to run. A binary pass/fail
 * hides that: it conflates "broken" with "2/3 stable" with "1/3 lucky".
 *
 * `stochasticTest` runs the test function N times, passes when at least
 * `minPass` runs succeed, and records a tier (`3/3`, `2/3`, `1/3`, `0/3`) to a
 * shared JSONL report. A companion aggregator reads that file and reports
 * distribution + a "weak" focus list of tests below the acceptance bar.
 *
 * Tuning knobs (env vars):
 *   - `ELIZA_STOCHASTIC_RUNS`   override N at runtime (default: per-call)
 *   - `ELIZA_STOCHASTIC_MIN_PASS` override minPass (default: per-call)
 *   - `ELIZA_STOCHASTIC_REPORT_DIR` override report directory
 *     (default: `<repo root>/.eliza`)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "vitest";

export interface StochasticOptions {
  /** Number of runs per invocation. Default 3. */
  runs?: number;
  /** Minimum passing runs required for the vitest assertion. Default 2. */
  minPass?: number;
  /** Per-run timeout in ms (total test timeout = this × runs). Default 60_000. */
  perRunTimeoutMs?: number;
  /** Human label for reports. Defaults to the test name. */
  label?: string;
}

export interface StochasticResultRecord {
  file: string;
  name: string;
  label: string;
  runs: number;
  passed: number;
  failed: number;
  tier: string;
  /** Up to 3 error messages from failing runs, truncated. */
  errors: string[];
  /** Milliseconds, total wall clock across all runs. */
  durationMs: number;
  /** Unix ms timestamp when the record was written. */
  ts: number;
}

const DEFAULT_RUNS = 3;
const DEFAULT_MIN_PASS = 2;
const DEFAULT_PER_RUN_TIMEOUT_MS = 60_000;

function resolveRepoRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 32; i++) {
    try {
      const gitPath = path.join(current, ".git");
      const stat = fs.statSync(gitPath, { throwIfNoEntry: false });
      // A repo root has `.git` as a directory. Submodules have it as a file
      // (a gitfile), which we skip so results always land at the top-level
      // checkout no matter where vitest is invoked from.
      if (stat?.isDirectory()) {
        return current;
      }
    } catch {
      // ignore
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return start;
}

function resolveReportDir(): string {
  const override = process.env.ELIZA_STOCHASTIC_REPORT_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(resolveRepoRoot(process.cwd()), ".eliza");
}

function reportFilePath(): string {
  return path.join(resolveReportDir(), "stochastic-results.jsonl");
}

function appendResult(record: StochasticResultRecord): void {
  try {
    const dir = resolveReportDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(reportFilePath(), `${JSON.stringify(record)}\n`, "utf-8");
  } catch {
    // Reporter errors should not fail the test.
  }
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function truncateMessage(value: unknown, max = 240): string {
  const text =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === "string"
        ? value
        : String(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function stochasticTest(
  name: string,
  fn: () => Promise<void> | void,
  options: StochasticOptions = {},
): void {
  const runs = envInt("ELIZA_STOCHASTIC_RUNS") ?? options.runs ?? DEFAULT_RUNS;
  const rawMinPass =
    envInt("ELIZA_STOCHASTIC_MIN_PASS") ?? options.minPass ?? DEFAULT_MIN_PASS;
  const minPass = Math.max(1, Math.min(runs, rawMinPass));
  const perRunTimeoutMs = options.perRunTimeoutMs ?? DEFAULT_PER_RUN_TIMEOUT_MS;
  const totalTimeoutMs = perRunTimeoutMs * runs + 5_000;

  test(
    name,
    async (ctx) => {
      const startedAt = Date.now();
      let passed = 0;
      const errors: string[] = [];
      for (let index = 0; index < runs; index++) {
        try {
          await fn();
          passed++;
        } catch (error) {
          errors.push(truncateMessage(error));
        }
      }
      const durationMs = Date.now() - startedAt;
      const failed = runs - passed;
      const file =
        (ctx.task.file as { name?: string } | undefined)?.name ?? "<unknown>";
      appendResult({
        file,
        name,
        label: options.label ?? name,
        runs,
        passed,
        failed,
        tier: `${passed}/${runs}`,
        errors: errors.slice(0, 3),
        durationMs,
        ts: Date.now(),
      });
      if (passed < minPass) {
        const preview = errors.slice(0, 3).join("\n---\n");
        throw new Error(
          `stochastic ${passed}/${runs} (min ${minPass}) failed runs:\n${preview}`,
        );
      }
    },
    totalTimeoutMs,
  );
}

/**
 * Conditional wrapper: runs as `stochasticTest` when the condition is true,
 * otherwise the test is skipped. Mirrors the `testIf` pattern used elsewhere.
 */
export function stochasticTestIf(
  condition: boolean,
): (
  name: string,
  fn: () => Promise<void> | void,
  options?: StochasticOptions,
) => void {
  if (condition) {
    return (name, fn, options) => stochasticTest(name, fn, options);
  }
  return (name) => {
    test.skip(name, () => {});
  };
}
