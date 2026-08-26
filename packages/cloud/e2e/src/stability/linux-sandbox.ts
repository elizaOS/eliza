/**
 * Builds the fail-closed Linux launcher boundary for stability scenario code.
 * The trusted attempt controller retains provider credentials and owns proxies;
 * only explicit loopback ports and a credential-minimal environment cross in.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

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
  const enabled = process.env.ELIZA_STABILITY_LINUX_SANDBOX === "1";
  if (process.platform === "linux" && mode === "real-llm" && !enabled) {
    throw new Error(
      "real-model stability on Linux requires ELIZA_STABILITY_LINUX_SANDBOX=1",
    );
  }
  if (process.env.ELIZA_STABILITY_LINUX_SANDBOX && !enabled) {
    throw new Error("ELIZA_STABILITY_LINUX_SANDBOX must be exactly 1");
  }
  return process.platform === "linux" && enabled;
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
      path.join(
        options.repoRoot,
        "packages/cloud/e2e/scripts/stability-linux-sandbox.sh",
      ),
      "run",
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
