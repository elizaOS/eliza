/**
 * Builds the fail-closed Linux launcher boundary for stability scenario code.
 * The trusted attempt controller retains provider credentials and owns proxies;
 * only explicit loopback ports and a credential-minimal environment cross in.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core/errors";
import type { NativeBootstrap } from "./native-bootstrap.ts";

/** Includes complete pre-admission and release scans in the native lane budget. */
export const NATIVE_STABILITY_TIMEOUT_MS = 600_000;
// The setup probe uses the same guardian allocation/cleanup path as an attempt.
const NATIVE_CAPABILITY_STOP_GRACE_MS = NATIVE_STABILITY_TIMEOUT_MS + 5_000;
const NATIVE_CAPABILITY_PARENT_TIMEOUT_MS =
  NATIVE_STABILITY_TIMEOUT_MS + NATIVE_CAPABILITY_STOP_GRACE_MS + 10_000;

const admittedSourceNames = new Set([
  "ANTHROPIC_BASE_URL",
  "BUN_OPTIONS",
  "CI",
  "CLOUD_E2E",
  "CONTROL_PLANE_TICK_MS",
  "ELIZA_REQUIRE_MOCK_SERVICES",
  "ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL",
  "ELIZA_STABILITY_ATTEMPT_ID",
  "ELIZA_STABILITY_AUTHORITY_INITIAL_STATE_HASH",
  "ELIZA_STABILITY_MODEL",
  "ELIZA_STABILITY_MODEL_MODE",
  "ELIZA_STABILITY_OUTPUT_DIR",
  "ELIZA_STABILITY_PROVIDER",
  "ELIZA_STABILITY_SCENARIO_FINGERPRINT",
  "ELIZA_STABILITY_SCENARIO_ID",
  "ELIZA_STABILITY_WORLD_FINGERPRINT",
  "ELIZA_STRICT_FIXTURE_MANIFEST_FINGERPRINT",
  "ELIZA_SYNTHETIC_CONTROL_URL",
  "ELIZA_SYNTHETIC_GENERATION",
  "ELIZA_SYNTHETIC_MANIFEST_ID",
  "ELIZA_SYNTHETIC_NAMESPACE",
  "LANG",
  "MOCK_HETZNER_ACTION_MS",
  "MOCK_HETZNER_LATENCY",
  "MOCK_REDIS",
  "NODE_ENV",
  "OPENAI_BASE_URL",
  "SCENARIO_USE_DETERMINISTIC_MODEL",
  "TZ",
]);

function assertEnvironmentEntry(name: string, value: string | undefined): void {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || value?.includes("\0")) {
    throw new Error(`invalid explicit sandbox environment entry: ${name}`);
  }
}

export function linuxSandboxEnabled(mode: string): boolean {
  const setting = process.env.ELIZA_STABILITY_LINUX_SANDBOX;
  const enabled = setting === "1";
  if (setting && !enabled) {
    throw new ElizaError("ELIZA_STABILITY_LINUX_SANDBOX must be exactly 1", {
      code: "STABILITY_SANDBOX_CONFIGURATION_INVALID",
    });
  }
  if (mode === "real-llm" && (process.platform !== "linux" || !enabled)) {
    throw new ElizaError(
      "Real-model stability requires Linux containment with ELIZA_STABILITY_LINUX_SANDBOX=1",
      {
        code: "STABILITY_SANDBOX_REQUIRED",
        context: { platform: process.platform },
      },
    );
  }
  if (enabled && process.platform !== "linux") {
    throw new ElizaError("Linux containment is unavailable on this platform", {
      code: "STABILITY_SANDBOX_UNSUPPORTED",
      context: { platform: process.platform },
    });
  }
  return process.platform === "linux" && enabled;
}

/** Admits the lane only after the actual privileged launcher proves its kernel prerequisites. */
export function assertLinuxSandboxCapabilities(
  repoRoot: string,
  mode: string,
  installedLauncher?: string,
): void {
  if (!linuxSandboxEnabled(mode)) return;
  const captureRoot = mkdtempSync(
    path.join(os.tmpdir(), "eliza-sandbox-capability-"),
  );
  const stdoutPath = path.join(captureRoot, "stdout.log");
  const stderrPath = path.join(captureRoot, "stderr.log");
  const descriptors: number[] = [];
  let primary: unknown;
  try {
    for (const target of [stdoutPath, stderrPath]) {
      const fd = openSync(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      descriptors.push(fd);
      if (!fstatSync(fd).isFile()) {
        throw new ElizaError("Capability capture is not a regular owned log", {
          code: "STABILITY_SANDBOX_CAPTURE_INVALID",
        });
      }
    }
    const probe = spawnSync(
      "sudo",
      [
        "-n",
        "/usr/bin/timeout",
        "--signal=TERM",
        `--kill-after=${NATIVE_CAPABILITY_STOP_GRACE_MS / 1_000}s`,
        `${NATIVE_STABILITY_TIMEOUT_MS / 1_000}s`,
        "/bin/bash",
        installedLauncher ??
          path.join(
            repoRoot,
            "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
          ),
        "setup",
      ],
      {
        encoding: "utf8",
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
        stdio: ["ignore", descriptors[0], descriptors[1]],
        timeout: NATIVE_CAPABILITY_PARENT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    const stdout = readFileSync(stdoutPath, "utf8");
    const stderr = readFileSync(stderrPath, "utf8");
    if (probe.error || probe.status !== 0 || stdout.trim() !== "ready") {
      throw new ElizaError(
        "Linux containment prerequisites are unavailable; configure the documented kernel permissions before running stability",
        {
          code: "STABILITY_SANDBOX_CAPABILITY_UNAVAILABLE",
          cause: probe.error,
          context: {
            exitCode: probe.status,
            signal: probe.signal,
            diagnostic: stderr,
          },
        },
      );
    }
  } catch (error) {
    // error-policy:J2 Preserve the admission failure alongside any teardown failure.
    primary = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const fd of descriptors) {
    try {
      closeSync(fd);
    } catch (error) {
      // error-policy:J2 Report every owned descriptor cleanup failure at this boundary.
      cleanupErrors.push(error);
    }
  }
  try {
    rmSync(captureRoot, { recursive: true });
  } catch (error) {
    // error-policy:J2 A retained capture directory is a failed cleanup, never success.
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0)
    throw new ElizaError("Containment capability capture cleanup failed", {
      code: "STABILITY_SANDBOX_CAPTURE_CLEANUP_FAILED",
      cause: new AggregateError(
        primary === undefined ? cleanupErrors : [primary, ...cleanupErrors],
      ),
    });
  if (primary !== undefined) throw primary;
}

function supervisorIdentity(): string {
  if (process.platform !== "linux" || typeof process.geteuid !== "function") {
    throw new ElizaError("Sandbox supervisor identity requires Linux", {
      code: "STABILITY_SANDBOX_SUPERVISOR_UNAVAILABLE",
    });
  }
  const record = readFileSync("/proc/self/stat", "utf8");
  const fields = record
    .substring(record.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/u);
  const startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(startTicks) || startTicks <= 0) {
    throw new ElizaError("Sandbox supervisor start identity is unavailable", {
      code: "STABILITY_SANDBOX_SUPERVISOR_UNAVAILABLE",
    });
  }
  return JSON.stringify({
    pid: process.pid,
    uid: process.geteuid(),
    startTicks,
  });
}

export function scenarioChildEnvironment(
  source: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !admittedSourceNames.has(name)) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(additions)) {
    assertEnvironmentEntry(name, value);
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function writeSandboxEnvironment(
  outputDir: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const environmentPath = path.join(
    outputDir,
    `.sandbox-environment-${randomBytes(12).toString("hex")}.bin`,
  );
  const records = Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      assertEnvironmentEntry(name, value);
      return `${name}=${value}\0`;
    });
  await writeFile(environmentPath, records.join(""), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return environmentPath;
}

export function loopbackPorts(urls: string[]): string {
  const ports = new Set<number>();
  for (const raw of urls) {
    const url = new URL(raw);
    if (url.hostname !== "127.0.0.1") {
      throw new Error(`sandbox endpoint is not IPv4 loopback: ${url.origin}`);
    }
    const port = Number(url.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        `sandbox endpoint has no explicit valid port: ${url.origin}`,
      );
    }
    ports.add(port);
  }
  if (ports.size === 0 || ports.size > 15) {
    throw new Error("sandbox requires between one and fifteen explicit ports");
  }
  return [...ports].sort((left, right) => left - right).join(",");
}

export function sandboxCommand(options: {
  enabled: boolean;
  nativeAdmission?: NativeBootstrap;
  allowedPorts: string;
  repoRoot: string;
  outputDir: string;
  environmentPath: string;
  callerHome: string;
  callerUid: number;
  runtime: string;
  args: string[];
}): { command: string; args: string[] } {
  if (!options.enabled) return { command: options.runtime, args: options.args };
  if (!Number.isSafeInteger(options.callerUid) || options.callerUid <= 0) {
    throw new Error("sandbox caller UID must be a positive safe integer");
  }
  return {
    command: "sudo",
    args: [
      "-n",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      "/bin/bash",
      options.nativeAdmission
        ? path.join(
            path.dirname(options.nativeAdmission.ownerScript),
            "stability-linux-sandbox.sh",
          )
        : path.join(
            options.repoRoot,
            "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
          ),
      options.nativeAdmission ? "run-native" : "run",
      supervisorIdentity(),
      ...(options.nativeAdmission
        ? [
            options.nativeAdmission.nativeBundle,
            JSON.stringify(options.nativeAdmission.request),
          ]
        : []),
      options.allowedPorts,
      options.repoRoot,
      options.outputDir,
      options.callerHome,
      String(options.callerUid),
      options.environmentPath,
      options.runtime,
      ...options.args,
    ],
  };
}
