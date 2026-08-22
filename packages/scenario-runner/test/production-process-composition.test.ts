/**
 * Proves manifest, lease, ledger, virtual-time, and control foundations across
 * independent real-runtime processes reopening one persistent PGlite world.
 */

/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ChannelType } from "@elizaos/core";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import {
  type JsonValue,
  SYNTHETIC_CONTROL_MAX_REQUEST_BYTES,
  SyntheticControlClient,
  SyntheticControlProtocolError,
  type SyntheticResetReceipt,
} from "@elizaos/shared/synthetic-control";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../cloud/test-mocks/src/synthetic-environment/sqlite-lease-store.ts";
import {
  type ProductionManifestV1,
  parseProductionManifestReceipt,
  serializeProductionManifestArtifact,
} from "../src/production-manifest.ts";

const TOKEN = "production-composition-token-0001";
const INITIAL_TIME_MS = 1_900_000_000_000;
const MAX_LOG_BYTES = 1_048_576;
const AMBIENT_SENTINEL = "SYNTHETIC_AMBIENT_SECRET_SENTINEL";
const originalAmbientSentinel = process.env[AMBIENT_SENTINEL];
const CHILD_ENV_ALLOWLIST = [
  "BUN_INSTALL",
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
] as const;
const fixturePath = fileURLToPath(
  new URL("./fixtures/production-synthetic-authority.ts", import.meta.url),
);

interface RunningAuthority {
  child: ChildProcessByStdio<null, Readable, Readable>;
  client: SyntheticControlClient;
  pid: number;
  agentId: string;
  url: string;
  pgliteDir: string;
  descendantPid: number | null;
  stdout: string;
  stderr: string;
  logOverflow: Error | null;
}

type CommandResult = Awaited<ReturnType<SyntheticControlClient["command"]>>;

const children: RunningAuthority[] = [];
let testRoot: string | null = null;

function appendBounded(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > limit) {
    throw new Error("production authority log exceeded its byte limit");
  }
  return next;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function bunExecutable(): Promise<string> {
  const configured = process.env.BUN_EXECUTABLE?.trim();
  if (configured) return configured;
  const installed = path.join(os.homedir(), ".bun", "bin", "bun");
  try {
    await access(installed, constants.X_OK);
    return installed;
  } catch {
    // error-policy:J4 CI images are expected to expose pinned Bun on PATH.
    return "bun";
  }
}

async function startAuthority(options: {
  namespace: string;
  stateRoot: string;
  initialTimeMs: number;
  receiptReadDelayMs?: number;
  spawnDescendant?: boolean;
  emitLogBytes?: number;
  logLimitBytes?: number;
}): Promise<RunningAuthority> {
  const child = spawn(
    await bunExecutable(),
    ["--conditions=eliza-source", fixturePath],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      detached: process.platform !== "win32",
      env: {
        ...childEnvironment(),
        NODE_ENV: "test",
        SCENARIO_USE_DETERMINISTIC_MODEL: "1",
        ELIZA_SAVE_TRAJECTORIES: "1",
        SYNTHETIC_CONTROL_NAMESPACE: options.namespace,
        SYNTHETIC_CONTROL_TOKEN: TOKEN,
        SYNTHETIC_LEASE_PATH: path.join(options.stateRoot, "lease.sqlite"),
        SYNTHETIC_RECEIPT_PATH: path.join(options.stateRoot, "receipt.json"),
        SYNTHETIC_LEDGER_PATH: path.join(options.stateRoot, "boundary.jsonl"),
        SYNTHETIC_INITIAL_TIME_MS: String(options.initialTimeMs),
        SYNTHETIC_RECEIPT_READ_DELAY_MS: String(
          options.receiptReadDelayMs ?? 0,
        ),
        SYNTHETIC_SPAWN_DESCENDANT: options.spawnDescendant ? "1" : "0",
        SYNTHETIC_EMIT_LOG_BYTES: String(options.emitLogBytes ?? 0),
        ELIZA_SCENARIO_PGLITE_DIR: path.join(options.stateRoot, "pglite"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let stdoutScanOffset = 0;
  let logOverflow: Error | null = null;
  let rejectReadiness: ((reason: Error) => void) | null = null;
  const killGroup = (): void => {
    if (process.platform === "win32" || child.pid === undefined) {
      child.kill("SIGKILL");
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // error-policy:J6 The process may already have exited after the capture failure.
    }
  };
  const capture = (stream: "stdout" | "stderr", chunk: Buffer): boolean => {
    try {
      if (stream === "stdout")
        stdout = appendBounded(
          stdout,
          chunk,
          options.logLimitBytes ?? MAX_LOG_BYTES,
        );
      else
        stderr = appendBounded(
          stderr,
          chunk,
          options.logLimitBytes ?? MAX_LOG_BYTES,
        );
      return true;
    } catch (error) {
      logOverflow =
        error instanceof Error
          ? error
          : new Error("authority log capture failed");
      rejectReadiness?.(logOverflow);
      killGroup();
      return false;
    }
  };
  child.stderr.on("data", (chunk: Buffer) => {
    capture("stderr", chunk);
  });
  const ready = await new Promise<{
    url: string;
    pid: number;
    agentId: string;
    pgliteDir: string;
    descendantPid: number | null;
  }>((resolve, reject) => {
    rejectReadiness = reject;
    const timeout = setTimeout(
      () => reject(new Error(`authority readiness timed out: ${stderr}`)),
      120_000,
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `authority exited before ready (code=${String(code)} signal=${String(signal)}): ${stderr}`,
        ),
      );
    };
    child.once("exit", onExit);
    child.stdout.on("data", (chunk: Buffer) => {
      if (!capture("stdout", chunk)) return;
      while (true) {
        const newline = stdout.indexOf("\n", stdoutScanOffset);
        if (newline < 0) return;
        const line = stdout.slice(stdoutScanOffset, newline);
        stdoutScanOffset = newline + 1;
        let parsed: {
          type?: unknown;
          url?: unknown;
          pid?: unknown;
          agentId?: unknown;
          pgliteDir?: unknown;
          descendantPid?: unknown;
        };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.type !== "ready") continue;
        if (
          typeof parsed.url !== "string" ||
          !Number.isSafeInteger(parsed.pid) ||
          typeof parsed.agentId !== "string" ||
          typeof parsed.pgliteDir !== "string" ||
          !(
            parsed.descendantPid === null ||
            Number.isSafeInteger(parsed.descendantPid)
          )
        ) {
          const error = new Error("authority returned an invalid ready frame");
          rejectReadiness = null;
          reject(error);
          killGroup();
          return;
        }
        if (parsed.pid !== child.pid) {
          const error = new Error(
            "authority ready frame pid does not match its child process",
          );
          rejectReadiness = null;
          reject(error);
          killGroup();
          return;
        }
        clearTimeout(timeout);
        child.off("exit", onExit);
        rejectReadiness = null;
        resolve({
          url: parsed.url,
          pid: parsed.pid as number,
          agentId: parsed.agentId,
          pgliteDir: parsed.pgliteDir,
          descendantPid: parsed.descendantPid as number | null,
        });
        return;
      }
    });
  });
  const running: RunningAuthority = {
    child,
    client: new SyntheticControlClient({
      baseUrl: ready.url,
      namespace: options.namespace,
      token: TOKEN,
      timeoutMs: 120_000,
    }),
    pid: ready.pid,
    agentId: ready.agentId,
    url: ready.url,
    pgliteDir: ready.pgliteDir,
    descendantPid: ready.descendantPid,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get logOverflow() {
      return logOverflow;
    },
  };
  children.push(running);
  return running;
}

async function waitForExit(
  running: RunningAuthority,
  message: string,
): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null)
    return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 30_000);
    running.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function terminateProcessGroup(
  running: RunningAuthority,
  signal: NodeJS.Signals,
): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null)
    return;
  if (process.platform === "win32") running.child.kill(signal);
  else process.kill(-running.pid, signal);
  await Promise.race([
    waitForExit(running, `process group ${running.pid} did not exit`),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`process group ${running.pid} did not exit`)),
        30_000,
      ),
    ),
  ]);
}

function object(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function canonicalHash(value: JsonValue): string {
  return createHash("sha256")
    .update(serializeProductionManifestArtifact(value))
    .digest("hex");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`descendant process ${pid} survived group teardown`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function assertSuccessfulObservation(
  value: JsonValue,
  expected: {
    order: number;
    surface: string;
    commandId: string;
    generation: string;
  },
): void {
  const entry = object(value, `ledger entry ${expected.order}`);
  expect(entry.order).toBe(expected.order);
  expect(entry.surface).toBe(expected.surface);
  expect(entry.idempotencyKey).toBe(expected.commandId);
  expect(entry.generation).toBe(expected.generation);
  expect(entry.result).toBe("succeeded");
  expect(entry.boundaryCalled).toBe(true);
  expect(entry.acceptance).toBe("accepted");
  expect(entry.responseSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(entry.readbackSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(entry.recordSha256).toMatch(/^[a-f0-9]{64}$/);
}

function manifest(
  namespace: string,
  ownerAgentId: string,
): ProductionManifestV1 {
  return {
    version: 1,
    namespace,
    ownerAgentId: ownerAgentId as ProductionManifestV1["ownerAgentId"],
    entities: [
      { id: "owner", names: ["Casey"], metadata: { role: "owner" } },
      { id: "teammate", names: ["Riley"] },
    ],
    rooms: [
      {
        id: "planning",
        name: "Planning",
        source: "production-composition",
        type: ChannelType.GROUP,
        participantEntityIds: ["owner", "teammate"],
      },
    ],
    memories: [
      {
        id: "message-1",
        roomId: "planning",
        entityId: "owner",
        text: "Persistent process A message",
      },
      {
        id: "fact-1",
        roomId: "planning",
        entityId: "teammate",
        text: "Process B must read this fact",
        tableName: "facts",
      },
    ],
    relationships: [
      {
        id: "team-link",
        sourceEntityId: "owner",
        targetEntityId: "teammate",
        tags: ["teammate"],
      },
    ],
    tasks: [
      {
        id: "due-task",
        name: "PRODUCTION_COMPOSITION_TASK",
        roomId: "planning",
        entityId: "owner",
        tags: ["queue", "composition"],
        dueAt: INITIAL_TIME_MS + 5_000,
      },
    ],
    schedules: [
      {
        id: "manual-review",
        task: {
          kind: "reminder",
          promptInstructions: "Review the persisted synthetic world.",
          trigger: { kind: "manual" },
          priority: "high",
          respectsGlobalPause: true,
          source: "plugin",
          createdBy: "production-composition",
          ownerVisible: true,
          subject: { kind: "entity", id: "owner" },
        },
      },
    ],
    notifications: [
      {
        id: "ready",
        title: "Persistent world ready",
        category: "system",
        priority: "high",
        source: "production-composition",
        groupKey: "ready",
        expiresAt: 2_100_000_000_000,
      },
    ],
    approvals: [
      {
        id: "approve-review",
        subjectEntityId: "owner",
        workflowId: "production-composition.review",
        input: { revision: 1, approved: true },
        reason: "Approve independent-process readback.",
        expiresAt: 2_100_000_000_000,
      },
    ],
    providerState: [
      {
        id: "cursor",
        key: "provider:composition:{{namespace}}:cursor",
        value: { page: 2, etag: "fixture-v1" },
      },
    ],
  };
}

async function protocolCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    // error-policy:J1 Test helper translates only the public protocol failure.
    if (error instanceof SyntheticControlProtocolError) return error.code;
    throw error;
  }
  throw new Error("expected protocol command to reject");
}

afterEach(async () => {
  for (const running of children.splice(0)) {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      try {
        await terminateProcessGroup(running, "SIGKILL");
      } catch {
        // error-policy:J6 The assertion reports lifecycle failures; cleanup only prevents a leaked child.
      }
    }
  }
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true });
    testRoot = null;
  }
  if (originalAmbientSentinel === undefined)
    delete process.env[AMBIENT_SENTINEL];
  else process.env[AMBIENT_SENTINEL] = originalAmbientSentinel;
});

describe("production synthetic process composition", () => {
  it("restarts, reads, advances, resets, fences stale work, and reseeds exactly", async () => {
    testRoot = await mkdtemp(path.join(os.tmpdir(), "production-composition-"));
    await chmod(testRoot, 0o700);
    process.env[AMBIENT_SENTINEL] = "must-not-cross-process-boundary";
    const namespace = "production-process-cycle";
    const processA = await startAuthority({
      namespace,
      stateRoot: testRoot,
      initialTimeMs: INITIAL_TIME_MS,
      spawnDescendant: true,
    });
    expect(processA.pgliteDir).toBe(path.join(testRoot, "pglite"));
    expect(processA.descendantPid).not.toBeNull();
    expect(processExists(processA.descendantPid as number)).toBe(true);
    const healthA = await processA.client.command({ type: "health" });
    expect(healthA.generation).toBe(0);
    const healthAData = object(healthA.data, "health A data");
    expect(healthAData.pending).toBe(0);
    expect(healthAData.ambientSentinelPresent).toBe(false);
    const acquired = await processA.client.command(
      {
        type: "lease.acquire",
        owner: "composition-controller",
        ttlMs: 300_000,
      },
      { expectedGeneration: 0, commandId: "lease-acquire" },
    );
    const acquiredData = object(acquired.data, "lease acquire data");
    const leaseId = acquiredData.leaseId;
    const authority =
      acquiredData.authority as unknown as SyntheticEnvironmentLeaseAuthority;
    expect(typeof leaseId).toBe("string");
    expect(acquired.generation).toBe(1);

    const contender = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(testRoot, "lease.sqlite"),
    );
    await expect(
      contender.acquire({
        namespace,
        owner: {
          ownerId: "simultaneous-contender",
          processId: null,
          host: "test",
        },
        leaseDurationMs: 300_000,
      }),
    ).rejects.toMatchObject({ code: "SYNTHETIC_LEASE_COLLISION" });
    contender.close();

    const productionManifest = manifest(namespace, processA.agentId);
    const seeded = await processA.client.command(
      {
        type: "seed",
        manifest: {
          version: 1,
          namespace,
          manifestId: "production-process-cycle-v1",
          domains: {
            productionManifest: productionManifest as unknown as JsonValue,
          },
        },
      },
      {
        expectedGeneration: 1,
        leaseId: leaseId as string,
        commandId: "seed-a",
      },
    );
    const resetReceipt = object(seeded.data, "seed data")
      .receipt as unknown as SyntheticResetReceipt;
    const snapshotAData = object(
      (
        await processA.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "snapshot-a",
          },
        )
      ).data,
      "snapshot A data",
    );
    const initialSnapshot = snapshotAData.snapshot as JsonValue;
    const initialHash = canonicalHash(initialSnapshot);
    const initialTask = object(
      (object(initialSnapshot, "initial snapshot").tasks as JsonValue[])[0],
      "initial task",
    );
    expect(initialTask.dueAt).toBe(INITIAL_TIME_MS + 5_000);
    const advancedA = await processA.client.command(
      { type: "time.advance", milliseconds: 1_000 },
      {
        expectedGeneration: 1,
        leaseId: leaseId as string,
        commandId: "advance-a",
      },
    );
    const advancedAData = object(advancedA.data, "advance A data");
    expect(advancedAData.pending).toBe(0);
    expect(advancedAData.taskEffect).toBeNull();
    let afterAdvanceA: CommandResult;
    try {
      afterAdvanceA = await processA.client.command(
        { type: "snapshot" },
        {
          expectedGeneration: 1,
          leaseId: leaseId as string,
          commandId: "after-advance-a",
        },
      );
    } catch (error) {
      throw new Error(`after advance A failed: ${processA.stderr}`, {
        cause: error,
      });
    }
    expect(
      canonicalHash(
        object(afterAdvanceA.data, "after advance A data")
          .snapshot as JsonValue,
      ),
    ).toBe(initialHash);
    await terminateProcessGroup(processA, "SIGKILL");
    expect(processA.child.signalCode).toBe("SIGKILL");
    await waitForProcessGone(processA.descendantPid as number);
    expect(processA.logOverflow).toBeNull();

    const receiptPath = path.join(testRoot, "receipt.json");
    const receiptBytes = await readFile(receiptPath);
    const processB = await startAuthority({
      namespace,
      stateRoot: testRoot,
      initialTimeMs: INITIAL_TIME_MS + 1_000,
      receiptReadDelayMs: 100,
    });
    const healthB = await processB.client.command({ type: "health" });
    expect(healthB.generation).toBe(1);
    expect(object(healthB.data, "health B data").pending).toBe(0);
    expect(processB.agentId).toBe(processA.agentId);
    expect(processB.pgliteDir).toBe(processA.pgliteDir);
    expect(processB.descendantPid).toBeNull();
    expect(
      parseProductionManifestReceipt(JSON.parse(receiptBytes.toString("utf8")))
        .ownerAgentId,
    ).toBe(processA.agentId);
    let baselineB: CommandResult;
    try {
      baselineB = await processB.client.command(
        { type: "snapshot" },
        {
          expectedGeneration: 1,
          leaseId: leaseId as string,
          commandId: "baseline-b",
        },
      );
    } catch (error) {
      throw new Error(`baseline B failed: ${processB.stderr}`, {
        cause: error,
      });
    }
    expect(
      canonicalHash(
        object(baselineB.data, "baseline B data").snapshot as JsonValue,
      ),
    ).toBe(initialHash);

    const malformed = await fetch(processB.client.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_REQUEST");
    const oversized = await fetch(processB.client.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "x".repeat(SYNTHETIC_CONTROL_MAX_REQUEST_BYTES + 1),
    });
    expect(oversized.status).toBe(400);
    expect((await oversized.json()).error.code).toBe("INVALID_REQUEST");

    await processB.client.command(
      {
        type: "fault.install",
        fault: {
          id: "snapshot-delay",
          scope: "production-control",
          operation: "snapshot",
          mode: "delay",
          count: 1,
          delayMs: 100,
        },
      },
      {
        expectedGeneration: 1,
        leaseId: leaseId as string,
        commandId: "install-snapshot-delay",
      },
    );
    const shortClient = new SyntheticControlClient({
      baseUrl: processB.url,
      namespace,
      token: TOKEN,
      timeoutMs: 20,
    });
    expect(
      await protocolCode(
        shortClient.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "timed-out-snapshot",
          },
        ),
      ),
    ).toBe("COMMAND_FAILED");

    const receiptBackup = path.join(testRoot, "receipt.backup.json");
    await rename(receiptPath, receiptBackup);
    await symlink(receiptBackup, receiptPath);
    expect(
      await protocolCode(
        processB.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "symlink-receipt",
          },
        ),
      ),
    ).toBe("COMMAND_FAILED");
    await unlink(receiptPath);
    await rename(receiptBackup, receiptPath);

    await writeFile(receiptPath, Buffer.alloc(1_048_577, 0x78));
    expect(
      await protocolCode(
        processB.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "oversize-receipt",
          },
        ),
      ),
    ).toBe("COMMAND_FAILED");
    await writeFile(receiptPath, receiptBytes);
    await writeFile(
      receiptPath,
      receiptBytes.subarray(0, Math.max(1, receiptBytes.length - 4)),
    );
    expect(
      await protocolCode(
        processB.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "truncated-receipt",
          },
        ),
      ),
    ).toBe("COMMAND_FAILED");
    await writeFile(receiptPath, receiptBytes);

    const swapOld = path.join(testRoot, "receipt.swap-old.json");
    const swapping = processB.client.command(
      { type: "snapshot" },
      {
        expectedGeneration: 1,
        leaseId: leaseId as string,
        commandId: "swapped-receipt",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rename(receiptPath, swapOld);
    await writeFile(receiptPath, receiptBytes);
    expect(await protocolCode(swapping)).toBe("COMMAND_FAILED");
    await rm(swapOld, { force: true });

    let snapshotBAfterRestart: CommandResult;
    try {
      snapshotBAfterRestart = await processB.client.command(
        { type: "snapshot" },
        {
          expectedGeneration: 1,
          leaseId: leaseId as string,
          commandId: "snapshot-b",
        },
      );
    } catch (error) {
      throw new Error(`snapshot B failed: ${processB.stderr}`, {
        cause: error,
      });
    }
    const snapshotBData = object(snapshotBAfterRestart.data, "snapshot B data");
    expect(canonicalHash(snapshotBData.snapshot as JsonValue)).toBe(
      initialHash,
    );
    const ledgerBeforeReset = object(
      (
        await processB.client.command(
          { type: "ledger.query", limit: 100 },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "ledger-b",
          },
        )
      ).data,
      "ledger data",
    );
    const entriesBeforeReset = ledgerBeforeReset.entries as JsonValue[];
    expect(entriesBeforeReset).toHaveLength(2);
    assertSuccessfulObservation(entriesBeforeReset[0], {
      order: 1,
      surface: "production-manifest.seed",
      commandId: "seed-a",
      generation: "1",
    });
    assertSuccessfulObservation(entriesBeforeReset[1], {
      order: 2,
      surface: "task-service.time.advance",
      commandId: "advance-a",
      generation: "1",
    });
    const advancedB = await processB.client.command(
      { type: "time.advance", milliseconds: 4_000 },
      {
        expectedGeneration: 1,
        leaseId: leaseId as string,
        commandId: "advance-b",
      },
    );
    const advancedBData = object(advancedB.data, "advance B data");
    expect(advancedBData.pending).toBe(0);
    const taskEffect = object(advancedBData.taskEffect, "task effect");
    expect(taskEffect.text).toBe(
      "Production composition task executed exactly once",
    );
    expect(taskEffect.createdAt).toBe(INITIAL_TIME_MS + 5_000);
    const healthAfterTask = object(
      (await processB.client.command({ type: "health" })).data,
      "health after task",
    );
    expect(healthAfterTask.pending).toBe(0);
    expect(healthAfterTask.taskEffect).toEqual(taskEffect);
    expect(processB.stderr).not.toContain("task worker failed");
    expect(processB.stderr).not.toContain("TASK_TICK_FAILED");
    expect(processB.stderr).not.toContain("Task execution failed");
    await processB.client.command(
      { type: "reset", receipt: resetReceipt },
      {
        expectedGeneration: 1,
        leaseId: leaseId as string,
        commandId: "reset-b",
      },
    );
    const empty = object(
      (
        await processB.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "empty-b",
          },
        )
      ).data,
      "empty snapshot data",
    );
    expect(empty.snapshot).toBeNull();
    expect(empty.taskEffect).toBeNull();
    const emptyHash = canonicalHash(empty.snapshot as JsonValue);

    const leaseController = new SqliteSyntheticEnvironmentLeaseStore(
      path.join(testRoot, "lease.sqlite"),
    );
    const rolled = await leaseController.rollover({
      authority,
      leaseDurationMs: 300_000,
    });
    expect(rolled.authority.generation).toBe(2);
    expect(
      await protocolCode(
        processB.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 1,
            leaseId: leaseId as string,
            commandId: "stale-command",
          },
        ),
      ),
    ).toBe("STALE_GENERATION");
    expect(
      await protocolCode(
        processB.client.command(
          { type: "reset", receipt: resetReceipt },
          {
            expectedGeneration: 2,
            leaseId: rolled.authority.leaseId,
            commandId: "stale-receipt",
          },
        ),
      ),
    ).toBe("STALE_GENERATION");

    const reseeded = await processB.client.command(
      {
        type: "seed",
        manifest: {
          version: 1,
          namespace,
          manifestId: "production-process-cycle-v1",
          domains: {
            productionManifest: productionManifest as unknown as JsonValue,
          },
        },
      },
      {
        expectedGeneration: 2,
        leaseId: rolled.authority.leaseId,
        commandId: "reseed-b",
      },
    );
    const finalSnapshot = object(
      (
        await processB.client.command(
          { type: "snapshot" },
          {
            expectedGeneration: 2,
            leaseId: rolled.authority.leaseId,
            commandId: "final-b",
          },
        )
      ).data,
      "final snapshot data",
    );
    expect(canonicalHash(finalSnapshot.snapshot as JsonValue)).toBe(
      initialHash,
    );
    expect(emptyHash).not.toBe(initialHash);
    expect(object(reseeded.data, "reseed data").receipt).toBeTruthy();

    const finalLedger = object(
      (
        await processB.client.command(
          { type: "ledger.query", limit: 100 },
          {
            expectedGeneration: 2,
            leaseId: rolled.authority.leaseId,
            commandId: "ledger-final",
          },
        )
      ).data,
      "final ledger data",
    );
    const finalEntries = finalLedger.entries as JsonValue[];
    expect(finalEntries).toHaveLength(5);
    assertSuccessfulObservation(finalEntries[2], {
      order: 3,
      surface: "task-service.time.advance",
      commandId: "advance-b",
      generation: "1",
    });
    assertSuccessfulObservation(finalEntries[3], {
      order: 4,
      surface: "production-manifest.reset",
      commandId: "reset-b",
      generation: "1",
    });
    assertSuccessfulObservation(finalEntries[4], {
      order: 5,
      surface: "production-manifest.seed",
      commandId: "reseed-b",
      generation: "2",
    });

    const teardown = await processB.client.command(
      { type: "teardown", reason: "composition cycle complete" },
      {
        expectedGeneration: 2,
        leaseId: rolled.authority.leaseId,
        commandId: "teardown-b",
      },
    );
    expect(object(teardown.data, "teardown data").pending).toBe(0);
    await waitForExit(processB, "process B teardown timed out");
    expect((await leaseController.read(namespace))?.status).toBe("released");
    leaseController.close();
    expect(processB.stderr).not.toContain("Unhandled");
    expect(processB.logOverflow).toBeNull();

    const overflowRoot = path.join(testRoot, "overflow-authority");
    await mkdir(overflowRoot, { recursive: true, mode: 0o700 });
    const overflowAuthority = await startAuthority({
      namespace: "production-process-log-overflow",
      stateRoot: overflowRoot,
      initialTimeMs: INITIAL_TIME_MS,
      emitLogBytes: 32_768,
      logLimitBytes: 16_384,
    });
    await waitForExit(
      overflowAuthority,
      "overflow authority did not terminate",
    );
    expect(overflowAuthority.logOverflow?.message).toContain("byte limit");

    const summary = {
      schemaVersion: 1,
      namespace,
      agentId: processA.agentId,
      pgliteDir: processA.pgliteDir,
      processIds: { a: processA.pid, b: processB.pid },
      generations: [1, 2],
      hashes: { initial: initialHash, empty: emptyHash, reseeded: initialHash },
      taskEffect: {
        id: taskEffect.id,
        createdAt: taskEffect.createdAt,
        persistedAfterRestart: true,
        count: 1,
      },
      ledger: {
        records: finalEntries.length,
        finalRecordSha256: object(finalEntries[4], "final ledger entry")
          .recordSha256,
      },
      teardown: {
        processAPidGone: !processExists(processA.pid),
        descendantPidGone: !processExists(processA.descendantPid as number),
        processBExited: processB.child.exitCode === 0,
        leaseReleased: true,
        pending: 0,
      },
    };
    expect(summary.hashes.empty).not.toBe(summary.hashes.initial);
    expect(summary.teardown).toMatchObject({
      processAPidGone: true,
      descendantPidGone: true,
      processBExited: true,
      leaseReleased: true,
      pending: 0,
    });
    process.stdout.write(
      `PRODUCTION_COMPOSITION_SUMMARY=${JSON.stringify(summary)}\n`,
    );
  }, 300_000);
});
