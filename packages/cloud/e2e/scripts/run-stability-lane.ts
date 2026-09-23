/**
 * Runs the manifest-driven exact-three Cloud lane through isolated subprocess
 * groups and a leased synthetic authority, retaining reset and aggregate proof.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ScenarioStabilitySubprocessAdapter } from "@elizaos/scenario-runner";
import { SyntheticControlClient } from "@elizaos/shared/synthetic-control";
import cloudStabilityScenario from "../scenarios/cloud-stability-agent.scenario.ts";
import { authorityChildEnvironment } from "../src/stability/cloud-stability-environment.ts";
import {
  type CloudStabilityMode,
  canonicalCloudStabilitySha256,
  parseCloudStabilityManifest,
  runCloudStabilityLane,
} from "../src/stability/cloud-stability-runner.ts";

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
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    if (Buffer.byteLength(stderr) > 256 * 1024)
      signalAuthorityGroup(child, "SIGKILL");
  });
  const ready = await new Promise<{ type: string; url: string }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        signalAuthorityGroup(child, "SIGKILL");
        reject(
          new Error("synthetic authority did not become ready in 15 seconds"),
        );
      }, 15_000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `synthetic authority exited before ready (${String(code)}): ${stderr.slice(0, 2_000)}`,
          ),
        );
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 4_096) {
          signalAuthorityGroup(child, "SIGKILL");
          clearTimeout(timeout);
          reject(
            new Error("synthetic authority ready record exceeded 4096 bytes"),
          );
          return;
        }
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        try {
          resolve(
            JSON.parse(stdout.slice(0, newline)) as {
              type: string;
              url: string;
            },
          );
        } catch (error) {
          // error-policy:J2 Invalid authority output is a controller failure with cause.
          reject(
            new Error("synthetic authority emitted invalid ready JSON", {
              cause: error,
            }),
          );
        }
      });
    },
  );
  if (ready.type !== "ready" || !ready.url.startsWith("http://127.0.0.1:")) {
    signalAuthorityGroup(child, "SIGKILL");
    throw new Error("synthetic authority emitted a non-loopback ready record");
  }
  return { child, url: ready.url };
}

function signalAuthorityGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    child.kill(signal);
  } catch (error) {
    // error-policy:J6 ESRCH proves the authority process group is absent.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    )
      return;
    throw error;
  }
}

async function stopAuthority(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  signalAuthorityGroup(child, "SIGTERM");
  const close = new Promise<boolean>((resolve) =>
    child.once("close", () => resolve(true)),
  );
  const wait = (milliseconds: number) =>
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), milliseconds),
    );
  if (await Promise.race([close, wait(5_000)])) return;
  signalAuthorityGroup(child, "SIGKILL");
  if (await Promise.race([close, wait(5_000)])) return;
  throw new Error("synthetic authority process survived SIGKILL");
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
    model: option("model") ?? route.defaultModel,
    modelMode: {
      kind: "real-llm",
      credentialEnv: route.credentialEnv,
      credentialValue,
    },
  };
}

const mode = modeOption();
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
    timeoutMs: 240_000,
    maxInputTokens: 100_000,
    maxOutputTokens: 50_000,
    maxToolCalls: 50,
  });
  const adapter = new ScenarioStabilitySubprocessAdapter({
    command: process.execPath,
    args: () => [
      "--conditions=eliza-source",
      path.join(repoRoot, "packages/cloud/e2e/scripts/stability-attempt.ts"),
    ],
    cwd: outputRoot,
    modelMode: selected.modelMode,
    env: {
      ELIZA_STABILITY_SCENARIO_FINGERPRINT: manifest.scenarioFingerprint,
      ELIZA_STABILITY_WORLD_FINGERPRINT: manifest.worldFingerprint,
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
  report = await runCloudStabilityLane({ manifest, outputRoot, adapter });

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
    await fetch(`${authority.url}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    // error-policy:J3 A refused loopback probe is the explicit closed-port state.
    portClosed = true;
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
    authorityTeardownError = new Error(
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
