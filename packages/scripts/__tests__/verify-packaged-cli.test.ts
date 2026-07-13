/**
 * Exercises the installed-package verifier with real child processes and
 * locks packaging workflows to the fail-closed verifier instead of masked
 * launcher commands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArguments, verifyPackagedCli } from "../verify-packaged-cli.mjs";

const repoRoot = new URL("../../../", import.meta.url);
const verifier = new URL("../verify-packaged-cli.mjs", import.meta.url);
const temporaryDirectories: string[] = [];

function fixture(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "eliza-packaged-cli-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "packaged-cli");
  writeFileSync(
    executable,
    `#!/usr/bin/env bash\nset -euo pipefail\n${contents}`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

function verify(executable: string, expected = "2.0.0"): string {
  return verifyPackagedCli(executable, [], expected);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged CLI verification", () => {
  test("accepts an executable with the exact version and usable help", () => {
    const executable = fixture(`
case "\${1:-}" in
  --version) printf '2.0.0\\n' ;;
  --help) printf 'Usage: eliza [options]\\n\\nOptions:\\n' ;;
  *) exit 64 ;;
esac
`);

    expect(verify(executable)).toContain("Usage: eliza");
  });

  test("rejects a launcher that cannot start its version path", () => {
    const executable = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf 'missing runtime dependency\\n' >&2
  exit 1
fi
printf 'Usage: eliza [options]\\n'
`);

    expect(() => verify(executable)).toThrow("exited 1");
  });

  test("rejects the wrong installed version", () => {
    const executable = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf '1.9.9\\n'
else
  printf 'Usage: eliza [options]\\n'
fi
`);

    expect(() => verify(executable)).toThrow("version mismatch");
  });

  test("rejects failed or content-free help", () => {
    const failedHelp = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.0.0\\n'
else
  exit 2
fi
`);
    const contentFreeHelp = fixture(`
if [[ "\${1:-}" == "--version" ]]; then
  printf '2.0.0\\n'
else
  printf 'installed\\n'
fi
`);

    expect(() => verify(failedHelp)).toThrow("exited 2");
    expect(() => verify(contentFreeHelp)).toThrow("Usage section");
  });

  test("parses wrapper arguments and exercises the command-line boundary", () => {
    const executable = fixture(`
case "\${1:-}" in
  --version) printf '2.0.0\\n' ;;
  --help) printf 'Usage: eliza [options]\\n' ;;
  *) exit 64 ;;
esac
`);

    expect(
      parseArguments(["--expected", "2.0.0", "--", executable, "wrapped"]),
    ).toEqual({
      command: executable,
      commandArgs: ["wrapped"],
      expectedVersion: "2.0.0",
    });

    const result = Bun.spawnSync({
      cmd: ["node", verifier.pathname, "--expected", "2.0.0", "--", executable],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Verified packaged CLI 2.0.0");
  });

  test("rejects malformed verifier arguments", () => {
    expect(() => parseArguments([])).toThrow("before the packaged command");
    expect(() => parseArguments(["--", "command"])).toThrow(
      "non-empty --expected",
    );
    expect(() => parseArguments(["--expected", "2.0.0", "--"])).toThrow(
      "packaged command",
    );
  });
});

interface WorkflowStep {
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

function stepRun(path: string, job: string, stepName: string): string {
  const step = workflow(path).jobs?.[job]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step?.run) {
    throw new Error(`Missing ${path} ${job} step ${stepName}`);
  }
  return step.run;
}

describe("package workflows", () => {
  const verifierName = "verify-packaged-cli.mjs";

  test("Snap and Flatpak test workflows use the fail-closed verifier", () => {
    const snap = stepRun(
      ".github/workflows/snap-build-test.yml",
      "build-snap",
      "Install and test snap",
    );
    const flatpak = stepRun(
      ".github/workflows/test-flatpak.yml",
      "build",
      "Install and test",
    );

    expect(snap).toContain(verifierName);
    expect(flatpak).toContain(verifierName);
    expect(snap).not.toMatch(/elizaos-app --(?:version|help).*\|\|/);
    expect(flatpak).not.toMatch(/ai\.elizaos\.App --(?:version|help).*\|\|/);
  });

  test("reusable publish jobs verify every installed launcher before publishing", () => {
    const publishPath = ".github/workflows/publish-packages.yml";
    const checks = [
      stepRun(publishPath, "publish-snap", "Test snap"),
      stepRun(publishPath, "build-deb", "Test .deb package"),
      stepRun(publishPath, "build-flatpak", "Test Flatpak"),
    ];

    for (const check of checks) {
      expect(check).toContain(verifierName);
      expect(check).not.toMatch(/--version.*\|\|/);
    }
  });
});
