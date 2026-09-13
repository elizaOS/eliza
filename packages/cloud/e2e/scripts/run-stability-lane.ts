/**
 * Runs the manifest-driven exact-three Cloud lane through isolated subprocess
 * groups and a leased synthetic authority, retaining reset and aggregate proof.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ScenarioStabilitySubprocessAdapter } from "@elizaos/scenario-runner/stability-subprocess-adapter";
import { SyntheticControlClient } from "@elizaos/shared/synthetic-control";
import cloudStabilityScenario from "../scenarios/cloud-stability-agent.scenario.ts";
import {
  authorityPortClosed,
  stopAuthority,
  waitForAuthorityReady,
} from "../src/stability/authority-process.ts";
import { authorityChildEnvironment } from "../src/stability/cloud-stability-environment.ts";
import {
  type CloudStabilityMode,
  canonicalCloudStabilitySha256,
  parseCloudStabilityManifest,
  runCloudStabilityLane,
} from "../src/stability/cloud-stability-runner.ts";
import {
  assertLinuxSandboxCapabilities,
  linuxSandboxEnabled,
  NATIVE_STABILITY_TIMEOUT_MS,
} from "../src/stability/linux-sandbox.ts";
import { createCloudNativeAdmission } from "../src/stability/native-admission.ts";
import type { NativeVerifierContext } from "../src/stability/native-attestation-channel.ts";
import { readNativeAuthority } from "../src/stability/native-authority.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const syntheticWorld = {
  messages: [{ room: "owner", text: "synthetic Cloud inbox ready" }],
  scheduling: { logicalClock: "2099-01-02T08:55:00.000Z" },
  notifications: [],
  cloud: { region: "fsn1", serverType: "cx22" },
} as const;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function modeOption(): CloudStabilityMode {
  const value = option("mode") ?? "deterministic-mock";
  if (value !== "deterministic-mock" && value !== "real-llm") {
    throw new Error("--mode must be deterministic-mock or real-llm");
  }
  return value;
}

function modelOption(defaultModel: string): string {
  const model = option("model") ?? defaultModel;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) {
    throw new Error("--model must be a bounded provider model identifier");
  }
  return model;
}

async function startAuthority(
  namespace: string,
  token: string,
): Promise<{
  child: ReturnType<typeof spawn>;
  url: string;
}> {
  const child = spawn(
    process.execPath,
    [
      "--conditions=eliza-source",
      path.join(
        repoRoot,
        "packages/cloud/test-mocks/test/fixtures/synthetic-control-authority.ts",
      ),
    ],
    {
      cwd: repoRoot,
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: authorityChildEnvironment(process.env, namespace, token),
    },
  );
  const url = await waitForAuthorityReady(child);
  return { child, url };
}

function installAuthoritySignalCleanup(
  child: ReturnType<typeof spawn>,
): () => void {
  let handling = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => {
      if (handling) return;
      handling = true;
      const reraise = (): void => {
        for (const [registeredSignal, registeredHandler] of handlers) {
          process.removeListener(registeredSignal, registeredHandler);
        }
        process.kill(process.pid, signal);
      };
      void stopAuthority(child).then(reraise, (error: unknown) => {
        // error-policy:J1 Signal cleanup reports the bounded teardown failure before preserving signal semantics.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[cloud-stability] authority signal cleanup failed: ${message.slice(0, 1_000)}\n`,
        );
        reraise();
      });
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // error-policy:J1 ESRCH is the explicit absent-process state.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function realModel(mode: CloudStabilityMode): {
  provider: string;
  model: string;
  modelMode:
    | { kind: "deterministic-mock"; fixtureManifestFingerprint: string }
    | { kind: "real-llm"; credentialEnv: string; credentialValue: string };
} {
  const fingerprint = canonicalCloudStabilitySha256(
    cloudStabilityScenario.modelFixtures,
  );
  if (mode === "deterministic-mock") {
    return {
      provider: "deterministic",
      model: "strict-fixtures",
      modelMode: {
        kind: "deterministic-mock",
        fixtureManifestFingerprint: fingerprint,
      },
    };
  }
  const provider = option("provider") ?? "openai";
  const routes = {
    openai: { credentialEnv: "OPENAI_API_KEY", defaultModel: "gpt-5-mini" },
    anthropic: {
      credentialEnv: "ANTHROPIC_API_KEY",
      defaultModel: "claude-sonnet-4-5",
    },
  } as const;
  const route = routes[provider as keyof typeof routes];
  if (!route) throw new Error("real lane supports only openai or anthropic");
  const credentialValue = process.env[route.credentialEnv];
  if (!credentialValue) {
    throw new Error(`real lane requires authorized ${route.credentialEnv}`);
  }
  return {
    provider,
    model: modelOption(route.defaultModel),
    modelMode: {
      kind: "real-llm",
      credentialEnv: route.credentialEnv,
      credentialValue,
    },
  };
}

const mode = modeOption();
const nativeRoot = option("native-root");
if (!linuxSandboxEnabled(mode) || !nativeRoot)
  throw new Error(
    "Cloud stability acceptance requires Linux containment and --native-root pointing to the root-installed observer build",
  );
const nativeAuthority = readNativeAuthority(repoRoot, nativeRoot);
const nativeTrust = new Map<string, NativeVerifierContext>();
assertLinuxSandboxCapabilities(
  repoRoot,
  mode,
  path.join(
    path.dirname(nativeAuthority.ownerScript),
    "stability-linux-sandbox.sh",
  ),
);
const selected = realModel(mode);
const runId =
  option("run-id") ??
  `cloud-stability-${mode}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const outputRoot = path.resolve(
  option("output") ?? path.join(repoRoot, "artifacts/cloud-stability", runId),
);
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const namespace = `cloud-stability-${randomBytes(8).toString("hex")}`;
const controlToken = randomBytes(32).toString("hex");
const authority = await startAuthority(namespace, controlToken);
const removeAuthoritySignalCleanup = installAuthoritySignalCleanup(
  authority.child,
);
const authorityTestReadyPath =
  process.env.ELIZA_STABILITY_AUTHORITY_TEST_READY_PATH;
if (authorityTestReadyPath) {
  await writeFile(
    path.resolve(authorityTestReadyPath),
    JSON.stringify({ pid: authority.child.pid, url: authority.url }),
    { encoding: "utf8", mode: 0o600 },
  );
}
const client = new SyntheticControlClient({
  baseUrl: authority.url,
  namespace,
  token: controlToken,
});

let report: Awaited<ReturnType<typeof runCloudStabilityLane>> | undefined;
let runError: unknown;
let authorityTeardownError: Error | undefined;
try {
  const manifest = parseCloudStabilityManifest({
    schemaVersion: 1,
    runId,
    mode,
    scenarioId: cloudStabilityScenario.id,
    provider: selected.provider,
    model: selected.model,
    scenarioFingerprint: canonicalCloudStabilitySha256(
      cloudStabilityScenario.contract,
    ),
    worldFingerprint: canonicalCloudStabilitySha256(syntheticWorld),
    ...(selected.modelMode.kind === "deterministic-mock"
      ? {
          fixtureManifestFingerprint:
            selected.modelMode.fixtureManifestFingerprint,
        }
      : {}),
    timeoutMs: NATIVE_STABILITY_TIMEOUT_MS,
    maxInputTokens: 100_000,
    maxOutputTokens: 50_000,
    maxModelRequests: 16,
    maxToolCalls: 50,
  });
  const adapter = new ScenarioStabilitySubprocessAdapter({
    nativeAdmission: createCloudNativeAdmission({
      manifest,
      authority: nativeAuthority.context,
      nativeBundle: nativeAuthority.nativeBundle,
      ownerScript: nativeAuthority.ownerScript,
      trusted: nativeTrust,
    }),
    command: process.execPath,
    args: () => [
      "--conditions=eliza-source",
      path.join(repoRoot, "packages/cloud/e2e/scripts/stability-attempt.ts"),
    ],
    cwd: outputRoot,
    modelMode: selected.modelMode,
    env: {
      ...(process.env.ELIZA_STABILITY_LINUX_SANDBOX
        ? {
            ELIZA_STABILITY_LINUX_SANDBOX:
              process.env.ELIZA_STABILITY_LINUX_SANDBOX,
          }
        : {}),
      ELIZA_STABILITY_SCENARIO_FINGERPRINT: manifest.scenarioFingerprint,
      ELIZA_STABILITY_WORLD_FINGERPRINT: manifest.worldFingerprint,
      ELIZA_STABILITY_MAX_INPUT_TOKENS: String(manifest.maxInputTokens),
      ELIZA_STABILITY_MAX_OUTPUT_TOKENS: String(manifest.maxOutputTokens),
      ELIZA_STABILITY_MAX_MODEL_REQUESTS: String(manifest.maxModelRequests),
    },
    syntheticControl: {
      controlUrl: authority.url,
      controlToken,
      manifest: {
        version: 1,
        namespace,
        manifestId: "cloud-stability-world-v1",
        domains: syntheticWorld,
      },
      timeoutMs: 15_000,
    },
  });
  report = await runCloudStabilityLane({
    manifest,
    outputRoot,
    adapter,
    verification: { nativeTrust },
  });

  const health = await client.command({ type: "health" });
  const acquired = await client.command(
    { type: "lease.acquire", owner: `${runId}-reset-audit`, ttlMs: 30_000 },
    { expectedGeneration: health.generation },
  );
  const lease = acquired.data as { leaseId?: unknown };
  if (typeof lease.leaseId !== "string")
    throw new Error("audit lease omitted id");
  const snapshot = await client.command(
    { type: "snapshot" },
    { expectedGeneration: acquired.generation, leaseId: lease.leaseId },
  );
  const snapshotRecord = snapshot.data as {
    generation?: unknown;
    manifest?: unknown;
    logicalTimeMs?: unknown;
    faultIds?: unknown;
  };
  if (
    snapshotRecord.generation !== acquired.generation ||
    snapshotRecord.manifest !== null ||
    snapshotRecord.logicalTimeMs !== 0 ||
    !Array.isArray(snapshotRecord.faultIds) ||
    snapshotRecord.faultIds.length !== 0
  ) {
    throw new Error(
      "synthetic authority retained pending world state after exact-three teardown",
    );
  }
  const queried = await client.command(
    { type: "ledger.query", afterSequence: 0, limit: 100 },
    { expectedGeneration: acquired.generation, leaseId: lease.leaseId },
  );
  const ledgerData = queried.data as { entries?: unknown };
  const entries = ledgerData.entries;
  if (!Array.isArray(entries))
    throw new Error("reset authority ledger omitted entries");
  const expectedOperations = [
    "lease.acquire",
    "seed",
    "reset",
    "lease.release",
    "lease.acquire",
    "seed",
    "reset",
    "lease.release",
    "lease.acquire",
    "seed",
    "reset",
    "lease.release",
    "lease.acquire",
  ];
  if (
    health.generation !== 12 ||
    entries.length !== expectedOperations.length ||
    entries.some((entry, index) => {
      const record = entry as {
        sequence?: unknown;
        generation?: unknown;
        operation?: unknown;
      };
      return (
        record.sequence !== index + 1 ||
        record.generation !== index + 1 ||
        record.operation !== expectedOperations[index]
      );
    })
  ) {
    throw new Error(
      "synthetic authority did not record the exact three seed/reset cycles",
    );
  }
  const resetProof = {
    namespace,
    reportStatus: report.status,
    ledger: queried.data,
    postAttemptHealthGeneration: health.generation,
    quiescentSnapshot: snapshot.data,
    ledgerSha256: canonicalCloudStabilitySha256(queried.data),
  };
  await writeFile(
    path.join(outputRoot, "reset-authority-ledger.json"),
    JSON.stringify(resetProof, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  await client.command(
    { type: "teardown", reason: "Cloud stability aggregate complete" },
    { expectedGeneration: queried.generation, leaseId: lease.leaseId },
  );
} catch (error) {
  runError = error;
} finally {
  await stopAuthority(authority.child);
  removeAuthoritySignalCleanup();
  const authorityPid = authority.child.pid;
  const pidAbsent = authorityPid ? !processExists(authorityPid) : false;
  let portClosed = false;
  try {
    portClosed = await authorityPortClosed(authority.url);
  } catch (error) {
    // error-policy:J1 Retain uncertain transport closure as a terminal teardown failure.
    authorityTeardownError =
      error instanceof Error ? error : new Error(String(error));
  }
  const authorityTeardownProof = {
    namespace,
    pid: authorityPid ?? null,
    command:
      "packages/cloud/test-mocks/test/fixtures/synthetic-control-authority.ts",
    url: authority.url,
    pidAbsent,
    portClosed,
  };
  await writeFile(
    path.join(outputRoot, "authority-teardown-proof.json"),
    JSON.stringify(authorityTeardownProof, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );
  if (!pidAbsent || !portClosed) {
    authorityTeardownError ??= new Error(
      "synthetic authority survived controller teardown",
    );
  }
}

if (runError && authorityTeardownError) {
  throw new AggregateError(
    [runError, authorityTeardownError],
    "Cloud stability lane and authority teardown both failed",
  );
}
if (runError) throw runError;
if (authorityTeardownError) throw authorityTeardownError;

if (!report)
  throw new Error("Cloud stability lane produced no aggregate report");
process.stdout.write(
  `${JSON.stringify({
    runId: report.runId,
    status: report.status,
    firstAttemptPassed: report.cells[0]?.firstAttemptPassed ?? false,
    passedAttempts: report.cells[0]?.passedAttempts ?? 0,
    outputRoot,
  })}\n`,
);
if (report.status !== "passed") process.exitCode = 1;
