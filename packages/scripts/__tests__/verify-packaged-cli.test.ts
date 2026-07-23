/**
 * Exercises packaged-launcher verification through real child processes and
 * locks release workflows to unmasked checks before publication.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArguments,
  runCommand,
  verifyPackagedCli,
} from "../verify-packaged-cli.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const verifierPath = fileURLToPath(
  new URL("../verify-packaged-cli.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];

interface LauncherOptions {
  help?: string;
  helpExit?: number;
  requiredPrefix?: string;
  stderrWarning?: string;
  version?: string;
  versionExit?: number;
}

function fixture(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "eliza-packaged-cli-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "launcher.mjs");
  writeFileSync(executable, source);
  return executable;
}

function launcher({
  help = "Usage: eliza [options]\n\nOptions:\n  --help  Show help\n",
  helpExit = 0,
  requiredPrefix,
  stderrWarning,
  version = "2.0.0",
  versionExit = 0,
}: LauncherOptions = {}): string {
  return fixture(`
const args = process.argv.slice(2);
const stderrWarning = ${stderrWarning === undefined ? "undefined" : JSON.stringify(stderrWarning)};
if (stderrWarning !== undefined) process.stderr.write(stderrWarning);
const requiredPrefix = ${requiredPrefix === undefined ? "undefined" : JSON.stringify(requiredPrefix)};
if (requiredPrefix !== undefined && args.shift() !== requiredPrefix) process.exit(64);
const flag = args.shift();
if (args.length > 0) process.exit(64);
if (flag === "--version") {
  process.stdout.write(${JSON.stringify(`${version}\n`)});
  process.exit(${versionExit});
}
if (flag === "--help") {
  process.stdout.write(${JSON.stringify(help)});
  process.exit(${helpExit});
}
process.exit(64);
`);
}

function verify(
  executable: string,
  {
    commandArgs = [],
    expectedVersion = "2.0.0",
    timeoutMs = 2_000,
  }: {
    commandArgs?: string[];
    expectedVersion?: string;
    timeoutMs?: number;
  } = {},
): string {
  return verifyPackagedCli(
    process.execPath,
    [executable, ...commandArgs],
    expectedVersion,
    { timeoutMs },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged CLI verification", () => {
  test.each([
    ["one-line", "Usage: eliza [options]\n\nOptions:\n  --help  Show help\n"],
    [
      "multiline",
      "Usage:\n  eliza [options]\n\nCommands:\n  serve  Start API\n",
    ],
  ])("accepts %s usage with the exact version and populated help", (_kind, help) => {
    expect(verify(launcher({ help }))).toMatch(/(?:Options|Commands):/);
  });

  test("rejects a command that cannot start", () => {
    const directory = mkdtempSync(join(tmpdir(), "eliza-missing-launcher-"));
    temporaryDirectories.push(directory);

    expect(() =>
      verifyPackagedCli(join(directory, "missing"), [], "2.0.0", {
        timeoutMs: 500,
      }),
    ).toThrow("Could not start");
  });

  test("rejects a missing runtime dependency and the wrong version", () => {
    expect(() => verify(launcher({ versionExit: 1 }))).toThrow("exited 1");
    expect(() => verify(launcher({ version: "1.9.9" }))).toThrow(
      "version mismatch",
    );
  });

  test("compares the version against stdout only, keeping stderr for diagnostics", () => {
    const stderrWarning =
      "(node:1) ExperimentalWarning: Type stripping is enabled\n";
    expect(verify(launcher({ stderrWarning }))).toMatch(
      /(?:Options|Commands):/,
    );
    expect(() => verify(launcher({ stderrWarning, version: "1.9.9" }))).toThrow(
      /version mismatch.*ExperimentalWarning/s,
    );
  });

  test("rejects failed or structurally empty help", () => {
    expect(() => verify(launcher({ helpExit: 2 }))).toThrow("exited 2");
    for (const help of [
      "installed\n",
      "Usage:\n",
      "Usage: eliza\n\nOptions:\n",
    ]) {
      expect(() => verify(launcher({ help }))).toThrow(
        "usable Usage and Commands/Options sections",
      );
    }
  });

  test("hard-kills a launcher that never returns", () => {
    const executable = fixture("setInterval(() => {}, 60_000);\n");
    const startedAt = Date.now();

    expect(() =>
      runCommand(process.execPath, [executable, "--version"], {
        timeoutMs: 100,
      }),
    ).toThrow("timed out after 100ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("exercises wrapper arguments through the command-line boundary", () => {
    const executable = launcher({ requiredPrefix: "wrapped" });
    const argv = [
      "--expected",
      "2.0.0",
      "--",
      process.execPath,
      executable,
      "wrapped",
    ];

    expect(parseArguments(argv)).toEqual({
      command: process.execPath,
      commandArgs: [executable, "wrapped"],
      expectedVersion: "2.0.0",
    });

    const success = spawnSync(process.execPath, [verifierPath, ...argv], {
      encoding: "utf8",
    });
    expect(success.status).toBe(0);
    expect(success.stdout).toContain("Verified packaged CLI 2.0.0");

    const failure = spawnSync(
      process.execPath,
      [
        verifierPath,
        "--expected",
        "9.9.9",
        "--",
        process.execPath,
        executable,
        "wrapped",
      ],
      { encoding: "utf8" },
    );
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("version mismatch");
  });

  test("rejects malformed verifier arguments and timeouts", () => {
    expect(() => parseArguments([])).toThrow("before the packaged command");
    expect(() => parseArguments(["--", "command"])).toThrow(
      "non-empty --expected",
    );
    expect(() => parseArguments(["--expected", "2.0.0", "--"])).toThrow(
      "packaged command",
    );
    expect(() =>
      parseArguments(["--unexpected", "value", "--", "command"]),
    ).toThrow("Unknown verifier argument");
    expect(() =>
      parseArguments([
        "--expected",
        "2.0.0",
        "--expected",
        "2.0.1",
        "--",
        "command",
      ]),
    ).toThrow("only be provided once");
    expect(() => runCommand(process.execPath, [], { timeoutMs: 0 })).toThrow(
      "positive integer",
    );
  });
});

interface WorkflowStep {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  name?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function workflow(path: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(new URL(path, repoRoot), "utf8"),
  ) as Workflow;
}

function workflowStep(
  path: string,
  job: string,
  stepName: string,
): WorkflowStep {
  const step = workflow(path).jobs?.[job]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return step;
}

function stepIndex(path: string, job: string, stepName: string): number {
  const index = workflow(path).jobs?.[job]?.steps?.findIndex(
    (candidate) => candidate.name === stepName,
  );
  if (index === undefined || index < 0) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return index;
}

function expectFailClosedSmoke(
  path: string,
  job: string,
  stepName: string,
  terminalCommand: RegExp,
): WorkflowStep {
  const step = workflowStep(path, job, stepName);
  if (!step.run) {
    throw new Error(`Missing run body for ${path} ${job} step ${stepName}`);
  }

  expect(step.run).toContain("set -euo pipefail");
  expect(step.run).toContain("verify-packaged-cli.mjs");
  expect(step.run.trimEnd()).toMatch(terminalCommand);
  expect(step["continue-on-error"]).toBeUndefined();
  return step;
}

function expectStepBefore(
  path: string,
  job: string,
  first: string,
  second: string,
): void {
  expect(stepIndex(path, job, first)).toBeLessThan(
    stepIndex(path, job, second),
  );
}

describe("package workflows", () => {
  test("Snap and Flatpak validation use terminal fail-closed checks", () => {
    const snap = expectFailClosedSmoke(
      ".github/workflows/snap-build-test.yml",
      "build-snap",
      "Install and test snap",
      /-- elizaos-app$/,
    );
    const flatpak = expectFailClosedSmoke(
      ".github/workflows/test-flatpak.yml",
      "build",
      "Install and test",
      /-- flatpak run ai\.elizaos\.App$/,
    );

    expect(snap.run).toContain("require('./package.json').version");
    expect(flatpak.run).toContain(
      "require('../../../../package.json').version",
    );
  });

  test("aggregate publish jobs verify installed launchers before publishing", () => {
    const path = ".github/workflows/publish-packages.yml";
    const checks = [
      {
        job: "publish-snap",
        publication: "Publish to Snap Store",
        smoke: "Test snap",
        terminalCommand: /-- elizaos-app$/,
      },
      {
        job: "build-deb",
        publication: "Attach .deb to GitHub Release",
        smoke: "Test .deb package",
        terminalCommand: /-- elizaos-app$/,
      },
      {
        job: "build-flatpak",
        publication: "Attach Flatpak to GitHub Release",
        smoke: "Test Flatpak",
        terminalCommand: /-- flatpak run ai\.elizaos\.App$/,
      },
    ];

    for (const { job, publication, smoke, terminalCommand } of checks) {
      const step = expectFailClosedSmoke(path, job, smoke, terminalCommand);
      expect(step.env?.EXPECTED_VERSION).toBe(
        "$" + "{{ needs.prepare.outputs.npm_version }}",
      );
      expectStepBefore(path, job, smoke, publication);
    }
  });
});
