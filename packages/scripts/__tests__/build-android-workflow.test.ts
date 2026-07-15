/** Executes the Android debug-keystore workflow step against deterministic command fixtures to pin its signer-identity and failure contracts. */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_SIGNER_SHA256 =
  "AFA5AFB6BA582F67222548872292341DF0BF6D625F705904858B81051DDE91F4";
const workflowSource = readFileSync(
  new URL("../../../.github/workflows/build-android.yml", import.meta.url),
  "utf8",
);

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const steps = workflow.jobs?.["build-android"]?.steps ?? [];
const restoreStep = steps.find(
  (candidate) => candidate.name === "Restore pinned debug keystore",
);

if (!restoreStep?.run) {
  throw new Error(
    "Build Android workflow is missing its keystore restore step",
  );
}

interface RunRestoreStepOptions {
  expectedFingerprint: string;
  keytoolMode?: "empty" | "missing" | "ok";
}

function runRestoreStep({
  expectedFingerprint,
  keytoolMode = "ok",
}: RunRestoreStepOptions): {
  keystoreMode: number | undefined;
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const root = mkdtempSync(join(tmpdir(), "android-keystore-workflow-"));
  const binDir = join(root, "bin");
  const homeDir = join(root, "home");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(binDir);
  mkdirSync(homeDir);
  mkdirSync(runnerTemp);

  const keytoolPath = join(binDir, "keytool");
  writeFileSync(
    keytoolPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_KEYTOOL_MODE:-ok}" == "missing" ]]; then
  echo "fixture signer alias not found" >&2
  exit 1
fi
keystore=""
storepass=""
alias=""
output=""
while (( $# > 0 )); do
  case "$1" in
    -keystore)
      keystore="$2"
      shift 2
      ;;
    -storepass)
      storepass="$2"
      shift 2
      ;;
    -alias)
      alias="$2"
      shift 2
      ;;
    -file)
      output="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
if [[ "$keystore" != "$HOME/.android/eliza-debug.keystore" ]]; then
  echo "fixture keytool received the wrong keystore path: $keystore" >&2
  exit 2
fi
if [[ "$storepass" != "android" ]]; then
  echo "fixture keytool received the wrong store password" >&2
  exit 2
fi
if [[ "$alias" != "androiddebugkey" ]]; then
  echo "fixture keytool received the wrong signer alias: $alias" >&2
  exit 2
fi
if [[ -z "$output" ]]; then
  echo "fixture keytool did not receive -file" >&2
  exit 2
fi
if [[ "\${FAKE_KEYTOOL_MODE:-ok}" == "empty" ]]; then
  : > "$output"
else
  printf '%s' "$FAKE_SIGNER_CERT" > "$output"
fi
`,
  );
  chmodSync(keytoolPath, 0o755);

  try {
    const result = spawnSync("bash", ["-c", restoreStep.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        ELIZA_ANDROID_DEBUG_KEYSTORE_BASE64:
          Buffer.from("fixture-keystore").toString("base64"),
        EXPECTED_ANDROID_DEBUG_SIGNER_SHA256: expectedFingerprint,
        FAKE_KEYTOOL_MODE: keytoolMode,
        FAKE_SIGNER_CERT: "deterministic-signer-certificate",
        HOME: homeDir,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: runnerTemp,
      },
    });
    const keystorePath = join(homeDir, ".android", "eliza-debug.keystore");
    return {
      keystoreMode:
        result.status === 0 ? statSync(keystorePath).mode & 0o777 : undefined,
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const fixtureFingerprint = createHash("sha256")
  .update("deterministic-signer-certificate")
  .digest("hex")
  .toUpperCase();

describe("Build Android workflow debug signer contract", () => {
  test("pins the production signer and verifies the exported certificate under strict bash", () => {
    expect(restoreStep.env?.EXPECTED_ANDROID_DEBUG_SIGNER_SHA256).toBe(
      EXPECTED_SIGNER_SHA256,
    );
    expect(restoreStep.run).toContain("set -euo pipefail");
    const setupJdkIndex = steps.findIndex(
      (candidate) => candidate.name === "Setup JDK 21",
    );
    const restoreIndex = steps.indexOf(restoreStep);
    const buildIndex = steps.findIndex(
      (candidate) => candidate.name === "Build debug APK",
    );
    expect(setupJdkIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(setupJdkIndex);
    expect(buildIndex).toBeGreaterThan(restoreIndex);

    const result = runRestoreStep({
      expectedFingerprint: fixtureFingerprint,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.keystoreMode).toBe(0o600);
    expect(result.stdout).toContain(
      `Verified pinned Android debug signer fingerprint: ${fixtureFingerprint}`,
    );
  });

  test("fails clearly when the restored keystore has the wrong signer", () => {
    const result = runRestoreStep({
      expectedFingerprint: EXPECTED_SIGNER_SHA256,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `fingerprint mismatch: expected ${EXPECTED_SIGNER_SHA256}, got ${fixtureFingerprint}`,
    );
  });

  test("fails clearly when the signer alias is missing or unreadable", () => {
    const result = runRestoreStep({
      expectedFingerprint: fixtureFingerprint,
      keytoolMode: "missing",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "missing a readable signer for alias androiddebugkey",
    );
  });

  test("fails clearly when keytool exports no signer certificate", () => {
    const result = runRestoreStep({
      expectedFingerprint: fixtureFingerprint,
      keytoolMode: "empty",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("signer certificate is empty");
  });
});
