/**
 * Deterministic process-boundary coverage for the scenario isolation wrapper.
 *
 * A temporary Bun shim emits controlled reports and child exit outcomes without
 * booting a runtime or requiring model credentials.
 */
import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const SCRIPT = path.join(
  REPO_ROOT,
  "packages",
  "scripts",
  "run-scenarios-isolated.mjs",
);

type ScenarioStatus = "passed" | "failed" | "skipped";

interface FixtureCase {
  status: ScenarioStatus;
  exitCode?: number;
  signal?: NodeJS.Signals;
  sleepMs?: number;
}

interface AggregateReport {
  totals: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  };
  scenarios: Array<{ id: string; status: ScenarioStatus }>;
}

const FAKE_BUN_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const command = args[1];
const cases = JSON.parse(process.env.ISOLATED_SCENARIO_CASES ?? "{}");

if (command === "list") {
  process.stdout.write(Object.keys(cases).join("\\n") + "\\n");
  process.exit(0);
}
if (command !== "run") {
  process.stderr.write("unexpected command: " + String(command) + "\\n");
  process.exit(2);
}

const scenarioIndex = args.indexOf("--scenario");
const reportIndex = args.indexOf("--report");
const id = args[scenarioIndex + 1];
const reportPath = args[reportIndex + 1];
const fixture = cases[id];
if (!fixture || !reportPath) {
  process.stderr.write("missing scenario fixture or report path\\n");
  process.exit(2);
}

if (process.env.ISOLATED_REQUIRE_UNIQUE_REPORT_ROOT === "1") {
  const normalized = reportPath.replaceAll("\\\\", "/");
  if (!normalized.includes("/scenario-isolated-run-") || !normalized.endsWith("/report.json")) {
    process.stderr.write("report path is not run-scoped: " + reportPath + "\\n");
    process.exit(2);
  }
}
if (fixture.sleepMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fixture.sleepMs);
}

fs.writeFileSync(
  reportPath,
  JSON.stringify({
    providerName: "fixture",
    scenarios: [{ id, status: fixture.status, durationMs: 1 }],
  }),
);
if (fixture.signal) {
  process.kill(process.pid, fixture.signal);
}
process.exit(fixture.exitCode ?? 0);
`;

function isolatedTmpReport(id: string): string {
  return path.join(
    "/tmp",
    `scenario-isolated-${id.replace(/[^a-z0-9._-]/gi, "_")}.json`,
  );
}

function runFixture(
  cases: Record<string, FixtureCase>,
  options: { args?: string[]; env?: Record<string, string> } = {},
): {
  result: ReturnType<typeof spawnSync>;
  report: AggregateReport;
} {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "scenario-isolation-status-"),
  );
  const binDir = path.join(fixtureRoot, "bin");
  const scenariosDir = path.join(fixtureRoot, "scenarios");
  const reportPath = path.join(fixtureRoot, "aggregate.json");
  const fakeBun = path.join(binDir, "bun");
  const tmpReports = Object.keys(cases).map(isolatedTmpReport);

  try {
    mkdirSync(binDir);
    mkdirSync(scenariosDir);
    writeFileSync(fakeBun, FAKE_BUN_SOURCE);
    chmodSync(fakeBun, 0o755);

    const result = spawnSync(
      process.execPath,
      [SCRIPT, scenariosDir, "--report", reportPath, ...(options.args ?? [])],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          ISOLATED_SCENARIO_CASES: JSON.stringify(cases),
          ...options.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    if (!existsSync(reportPath)) {
      throw new Error(
        `isolated runner produced no aggregate report: ${result.stderr}`,
      );
    }
    const report = JSON.parse(
      readFileSync(reportPath, "utf8"),
    ) as AggregateReport;
    return { result, report };
  } finally {
    for (const tmpReport of tmpReports) {
      rmSync(tmpReport, { force: true });
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("run-scenarios-isolated resolves the real scenario-runner CLI", () => {
  const result = spawnSync(
    "bun",
    ["packages/scripts/run-scenarios-isolated.mjs", "--print-paths"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  const paths = JSON.parse(result.stdout) as { repoRoot: string; cli: string };
  expect(paths.repoRoot).toBe(REPO_ROOT);
  expect(paths.cli).toBe(
    path.join(REPO_ROOT, "packages", "scenario-runner", "src", "cli.ts"),
  );
  expect(paths.cli).not.toContain("packages/eliza/packages");
  expect(existsSync(paths.cli)).toBe(true);
});

test("a skipped report from an exit-2 child is failed and untrusted", () => {
  const { result, report } = runFixture({
    "exit-2-skipped": { status: "skipped", exitCode: 2 },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("exit-2-skipped failed (exit 2)");
  expect(report.totals).toEqual({
    passed: 0,
    failed: 1,
    skipped: 0,
    total: 1,
  });
  expect(report.scenarios).toEqual([]);
});

test("a child terminated without an exit status is failed", () => {
  const { result, report } = runFixture({
    "signal-skipped": { status: "skipped", signal: "SIGTERM" },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("signal-skipped failed (signal SIGTERM)");
  expect(report.totals).toEqual({
    passed: 0,
    failed: 1,
    skipped: 0,
    total: 1,
  });
  expect(report.scenarios).toEqual([]);
});

test("a legitimate skipped report from a zero-exit child remains skipped", () => {
  const { result, report } = runFixture({
    "zero-skipped": { status: "skipped", exitCode: 0 },
  });

  expect(result.status).toBe(0);
  expect(report.totals).toEqual({
    passed: 0,
    failed: 0,
    skipped: 1,
    total: 1,
  });
  expect(report.scenarios).toEqual([
    { id: "zero-skipped", status: "skipped", durationMs: 1 },
  ]);
});

test("zero-exit pass and fail reports retain their report semantics", () => {
  const { result, report } = runFixture({
    "zero-passed": { status: "passed", exitCode: 0 },
    "zero-failed": { status: "failed", exitCode: 0 },
  });

  expect(result.status).toBe(1);
  expect(report.totals).toEqual({
    passed: 1,
    failed: 1,
    skipped: 0,
    total: 2,
  });
  expect(report.scenarios).toEqual([
    { id: "zero-passed", status: "passed", durationMs: 1 },
    { id: "zero-failed", status: "failed", durationMs: 1 },
  ]);
});

test("each child writes into a collision-free run directory", () => {
  const { result, report } = runFixture(
    {
      "same/sanitized": { status: "passed" },
      "same:sanitized": { status: "passed" },
    },
    {
      env: { ISOLATED_REQUIRE_UNIQUE_REPORT_ROOT: "1" },
      args: ["--workers", "2"],
    },
  );

  expect(result.status).toBe(0);
  expect(report.totals.passed).toBe(2);
});

test("a timed-out child fails instead of hanging the lane", () => {
  const { result, report } = runFixture(
    { slow: { status: "passed", sleepMs: 1_500 } },
    { args: ["--timeout-ms", "1000"] },
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("slow failed (timeout after 1000ms)");
  expect(report.totals.failed).toBe(1);
});

test("rejects unsafe worker counts before launching children", () => {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "scenario-isolation-invalid-"),
  );
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, fixtureRoot, "--workers", "0"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "--workers must be an integer from 1 through 32",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
