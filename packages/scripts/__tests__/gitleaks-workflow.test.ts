/**
 * Verifies the dedicated gitleaks workflow installs the pinned OSS scanner
 * through a deterministic, integrity-checked cache and bounded download path.
 * The shell harness uses local archives and a fake curl; it performs no network
 * operations or secret scans.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = Bun.YAML.parse(
  readFileSync(join(repoRoot, ".github/workflows/gitleaks.yml"), "utf8"),
) as Workflow;
const job = workflow.jobs?.gitleaks;
if (!job) throw new Error("Missing gitleaks workflow job");

function requireStep(name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing gitleaks workflow step: ${name}`);
  return step;
}

const cacheStep = requireStep("Restore gitleaks archive");
const installStep = requireStep(
  "Install gitleaks (OSS binary — no license required)",
);
const installSource = installStep.run;
if (!installSource) throw new Error("Missing gitleaks install shell source");
const scanStep = requireStep("Run gitleaks");
const scanSource = scanStep.run;
if (!scanSource) throw new Error("Missing gitleaks scan shell source");

function buildArchive(root: string, reportedVersion: string): string {
  const payload = join(root, "payload");
  const archive = join(root, `gitleaks-${reportedVersion}.tar.gz`);
  mkdirSync(payload, { recursive: true });
  const binary = join(payload, "gitleaks");
  writeFileSync(
    binary,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_GITLEAKS_INVOCATIONS:-}" ]]; then
  printf '%s\\n' "$*" >> "$FAKE_GITLEAKS_INVOCATIONS"
fi
if [[ "\${1:-}" == "version" ]]; then
  printf '%s\\n' ${JSON.stringify(reportedVersion)}
fi
`,
  );
  chmodSync(binary, 0o755);
  const result = spawnSync(
    "tar",
    ["-czf", archive, "-C", payload, "gitleaks"],
    {
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return archive;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executeInstaller(options: {
  archive: string;
  cachedBytes?: string | Uint8Array;
  expectedSha256?: string;
  expectedVersion?: string;
}) {
  const sandbox = mkdtempSync(join(tmpdir(), "eliza-gitleaks-workflow-"));
  const runnerTemp = join(sandbox, "runner-temp");
  const home = join(sandbox, "home");
  const fakeBin = join(sandbox, "fake-bin");
  const curlArgs = join(sandbox, "curl-args.txt");
  const githubOutput = join(sandbox, "github-output.txt");
  const version = options.expectedVersion ?? "8.30.1";
  const cacheDir = join(runnerTemp, "gitleaks-download-cache");
  const cachedArchive = join(cacheDir, `gitleaks_${version}_linux_x64.tar.gz`);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  if (options.cachedBytes !== undefined) {
    writeFileSync(cachedArchive, options.cachedBytes);
  }
  const fakeCurl = join(fakeBin, "curl");
  writeFileSync(
    fakeCurl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" >"$FAKE_CURL_ARGS"
output=''
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == '--output' ]]; then
    output="$2"
    break
  fi
  shift
done
[[ -n "$output" ]]
cp "$FAKE_GITLEAKS_ARCHIVE" "$output"
`,
  );
  chmodSync(fakeCurl, 0o755);

  const result = spawnSync("bash", ["-c", installSource], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_CURL_ARGS: curlArgs,
      FAKE_GITLEAKS_ARCHIVE: options.archive,
      GITHUB_OUTPUT: githubOutput,
      GITLEAKS_LINUX_X64_SHA256:
        options.expectedSha256 ?? sha256(options.archive),
      GITLEAKS_VERSION: version,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runnerTemp,
    },
  });

  const output = existsSync(githubOutput)
    ? readFileSync(githubOutput, "utf8")
    : "";
  const installedBinary = /^binary=(.+)$/m.exec(output)?.[1] ?? null;
  return {
    cachedArchive,
    curlArgs,
    home,
    installedBinary,
    result,
    runnerTemp,
    sandbox,
  };
}

describe("gitleaks workflow installer", () => {
  test("pins the cache to the official version and archive digest", () => {
    expect(job.env).toEqual({
      GITLEAKS_VERSION: "8.30.1",
      GITLEAKS_LINUX_X64_SHA256:
        "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    });
    expect(cacheStep.uses).toMatch(/^actions\/cache@[0-9a-f]{40}$/);
    expect(cacheStep.with?.path).toBe(
      "$" + "{{ runner.temp }}/gitleaks-download-cache",
    );
    expect(cacheStep.with?.key).toContain("$" + "{{ runner.os }}");
    expect(cacheStep.with?.key).toContain("$" + "{{ runner.arch }}");
    expect(cacheStep.with?.key).toContain("$" + "{{ env.GITLEAKS_VERSION }}");
    expect(cacheStep.with?.key).toContain(
      "$" + "{{ env.GITLEAKS_LINUX_X64_SHA256 }}",
    );
  });

  test("replaces a corrupt cache entry with a verified retried download", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-gitleaks-archive-"));
    const archive = buildArchive(fixture, "8.30.1");
    const execution = executeInstaller({ archive, cachedBytes: "corrupt" });
    try {
      expect(
        execution.result.status,
        `${execution.result.stdout}\n${execution.result.stderr}`,
      ).toBe(0);
      expect(execution.result.stderr).toContain(
        "cached archive failed SHA-256 verification",
      );
      expect(sha256(execution.cachedArchive)).toBe(sha256(archive));
      const args = readFileSync(execution.curlArgs, "utf8");
      expect(args).toContain("--retry\n5");
      expect(args).toContain("--retry-all-errors");
      expect(args).toContain("--connect-timeout\n30");
      expect(args).toContain("--max-time\n300");
      expect(args).toContain("--retry-max-time\n300");
    } finally {
      rmSync(execution.sandbox, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("uses a verified cache entry without contacting the release host", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-gitleaks-cache-"));
    const archive = buildArchive(fixture, "8.30.1");
    const execution = executeInstaller({
      archive,
      cachedBytes: readFileSync(archive),
    });
    try {
      expect(
        execution.result.status,
        `${execution.result.stdout}\n${execution.result.stderr}`,
      ).toBe(0);
      expect(existsSync(execution.curlArgs)).toBe(false);
      expect(execution.result.stdout).toContain("verified version 8.30.1");
      expect(execution.installedBinary).not.toBeNull();
      expect(execution.installedBinary?.startsWith(execution.runnerTemp)).toBe(
        true,
      );
      expect(existsSync(join(execution.home, ".local/bin/gitleaks"))).toBe(
        false,
      );
    } finally {
      rmSync(execution.sandbox, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("runs the verified per-job binary even when the shared PATH is poisoned", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-gitleaks-isolation-"));
    const archive = buildArchive(fixture, "8.30.1");
    const execution = executeInstaller({
      archive,
      cachedBytes: readFileSync(archive),
    });
    try {
      expect(
        execution.result.status,
        `${execution.result.stdout}\n${execution.result.stderr}`,
      ).toBe(0);
      expect(execution.installedBinary).not.toBeNull();

      const sharedBin = join(execution.home, ".local/bin");
      const poisonMarker = join(execution.sandbox, "poison-ran.txt");
      const verifiedInvocations = join(
        execution.sandbox,
        "verified-invocations.txt",
      );
      mkdirSync(sharedBin, { recursive: true });
      const poisonedBinary = join(sharedBin, "gitleaks");
      writeFileSync(
        poisonedBinary,
        `#!/usr/bin/env bash\nprintf 'poisoned\\n' > ${JSON.stringify(poisonMarker)}\n`,
      );
      chmodSync(poisonedBinary, 0o755);

      const scan = spawnSync("bash", ["-c", scanSource], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          BEFORE_SHA: "base-sha",
          CURRENT_SHA: "head-sha",
          EVENT_NAME: "push",
          FAKE_GITLEAKS_INVOCATIONS: verifiedInvocations,
          GITLEAKS_BIN: execution.installedBinary ?? "",
          HOME: execution.home,
          PATH: `${sharedBin}:${process.env.PATH ?? ""}`,
          PR_BASE_SHA: "",
          PR_HEAD_SHA: "",
        },
      });

      expect(scan.status, `${scan.stdout}\n${scan.stderr}`).toBe(0);
      expect(existsSync(poisonMarker)).toBe(false);
      expect(readFileSync(verifiedInvocations, "utf8")).toContain("detect");
      expect(execution.installedBinary).not.toBe(poisonedBinary);
    } finally {
      rmSync(execution.sandbox, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("fails closed before caching a download with the wrong digest", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-gitleaks-digest-"));
    const archive = buildArchive(fixture, "8.30.1");
    const execution = executeInstaller({
      archive,
      expectedSha256: "0".repeat(64),
    });
    try {
      expect(execution.result.status).toBe(1);
      expect(execution.result.stderr).toContain(
        "downloaded archive failed SHA-256 verification",
      );
      expect(existsSync(execution.cachedArchive)).toBe(false);
    } finally {
      rmSync(execution.sandbox, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("fails closed when the extracted scanner reports another version", () => {
    const fixture = mkdtempSync(join(tmpdir(), "eliza-gitleaks-version-"));
    const archive = buildArchive(fixture, "8.29.0");
    const execution = executeInstaller({ archive });
    try {
      expect(execution.result.status).toBe(1);
      expect(execution.result.stderr).toContain(
        "expected version 8.30.1, got 8.29.0",
      );
    } finally {
      rmSync(execution.sandbox, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("wires the scan to the installer output instead of a shared PATH", () => {
    expect(installStep.id).toBe("gitleaks-install");
    expect(installSource).not.toContain("$HOME/.local/bin");
    expect(installSource).not.toContain("$GITHUB_PATH");
    expect(scanStep.env?.GITLEAKS_BIN).toBe(
      "$" + "{{ steps.gitleaks-install.outputs.binary }}",
    );
    expect(scanSource).toContain('"$GITLEAKS_BIN" detect');
  });
});
