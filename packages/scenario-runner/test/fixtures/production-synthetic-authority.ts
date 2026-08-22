/**
 * Hosts one real scenario AgentRuntime behind the shared synthetic-control
 * protocol. Each process reopens the controller-owned PGlite directory,
 * generation lease, receipt artifact, and append-only boundary ledger.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  ServiceType,
  stringToUuid,
  TaskService,
  type TaskServiceClock,
  type TaskServiceTimerHandle,
} from "@elizaos/core";
import type { SyntheticEnvironmentLeaseAuthority } from "@elizaos/shared/contracts/synthetic-environment-lease";
import {
  createSyntheticControlHandler,
  type JsonValue,
  type SyntheticControlAuthority,
  type SyntheticControlCommand,
  type SyntheticControlExecutionContext,
  SyntheticControlProtocolError,
  type SyntheticFault,
} from "@elizaos/shared/synthetic-control";
import { SqliteSyntheticEnvironmentLeaseStore } from "../../../cloud/test-mocks/src/synthetic-environment/sqlite-lease-store.ts";
import {
  applyProductionManifest,
  JsonlBoundaryObservationLedger,
  observeProductionBoundary,
  type ProductionManifestReceipt,
  parseProductionManifestReceipt,
  readProductionManifestSnapshot,
  resetProductionManifest,
  serializeProductionManifestArtifact,
} from "../../src/index.ts";
import { createScenarioRuntime } from "../../src/runtime-factory.ts";

const MAX_RECEIPT_BYTES = 1_048_576;
const namespace = requiredEnv("SYNTHETIC_CONTROL_NAMESPACE");
const token = requiredEnv("SYNTHETIC_CONTROL_TOKEN");
const leasePath = absoluteEnv("SYNTHETIC_LEASE_PATH");
const receiptPath = absoluteEnv("SYNTHETIC_RECEIPT_PATH");
const ledgerPath = absoluteEnv("SYNTHETIC_LEDGER_PATH");
const pgliteDir = absoluteEnv("ELIZA_SCENARIO_PGLITE_DIR");
const initialTimeMs = Number(requiredEnv("SYNTHETIC_INITIAL_TIME_MS"));
const receiptReadDelayMs = Number(
  process.env.SYNTHETIC_RECEIPT_READ_DELAY_MS ?? "0",
);
const spawnDescendant = process.env.SYNTHETIC_SPAWN_DESCENDANT === "1";
const emitLogBytes = Number(process.env.SYNTHETIC_EMIT_LOG_BYTES ?? "0");
if (!Number.isSafeInteger(initialTimeMs)) {
  throw new Error("SYNTHETIC_INITIAL_TIME_MS must be a safe integer");
}
if (
  !Number.isSafeInteger(receiptReadDelayMs) ||
  receiptReadDelayMs < 0 ||
  receiptReadDelayMs > 5_000
) {
  throw new Error("SYNTHETIC_RECEIPT_READ_DELAY_MS must be between 0 and 5000");
}
if (
  !Number.isSafeInteger(emitLogBytes) ||
  emitLogBytes < 0 ||
  emitLogBytes > 2_097_152
) {
  throw new Error("SYNTHETIC_EMIT_LOG_BYTES must be between 0 and 2097152");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absoluteEnv(name: string): string {
  const value = requiredEnv(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

class ControllerClock implements TaskServiceClock {
  #now: number;
  readonly #callbacks = new Set<() => Promise<void>>();

  constructor(now: number) {
    this.#now = now;
  }

  now(): number {
    return this.#now;
  }

  setInterval(callback: () => Promise<void>): TaskServiceTimerHandle {
    this.#callbacks.add(callback);
    return callback;
  }

  clearInterval(handle: TaskServiceTimerHandle): void {
    this.#callbacks.delete(handle as () => Promise<void>);
  }

  async advance(milliseconds: number): Promise<void> {
    this.#now += milliseconds;
    await Promise.all([...this.#callbacks].map((callback) => callback()));
  }
}

const clock = new ControllerClock(initialTimeMs);
const runtimeHost = await createScenarioRuntime({
  characterId: stringToUuid(`${namespace}:production-composition-agent`),
  useDeterministicModel: true,
  taskServiceClock: clock,
  bootstrapMode: "production-foundations",
});
const runtime = runtimeHost.runtime;
const taskEffectId = stringToUuid(
  `${namespace}:production-composition-task-effect`,
);
runtime.registerTaskWorker({
  name: "PRODUCTION_COMPOSITION_TASK",
  execute: async (workerRuntime, _options, task) => {
    try {
      if (!task.roomId || !task.entityId) {
        throw new Error(
          "production composition task requires room and entity ownership",
        );
      }
      if (await workerRuntime.getMemoryById(taskEffectId)) {
        throw new Error("production composition task effect already exists");
      }
      await workerRuntime.createMemories([
        {
          memory: {
            id: taskEffectId,
            agentId: workerRuntime.agentId,
            worldId: task.worldId,
            roomId: task.roomId,
            entityId: task.entityId,
            createdAt: clock.now(),
            content: {
              text: "Production composition task executed exactly once",
              source: "production-composition",
            },
          },
          tableName: "facts",
        },
      ]);
    } catch (error) {
      process.stderr.write(`task worker failed: ${diagnosticCode(error)}\n`);
      throw error;
    }
  },
});
const leaseStore = new SqliteSyntheticEnvironmentLeaseStore(leasePath);
const ledger = new JsonlBoundaryObservationLedger(ledgerPath);
const faults = new Map<string, SyntheticFault>();
let stopping = false;
const descendant = spawnDescendant
  ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    })
  : null;

async function readTaskEffect(): Promise<JsonValue> {
  const effect = await runtime.getMemoryById(taskEffectId);
  return effect
    ? {
        id: effect.id ?? null,
        roomId: effect.roomId,
        entityId: effect.entityId,
        createdAt: effect.createdAt ?? null,
        text:
          typeof effect.content.text === "string" ? effect.content.text : null,
      }
    : null;
}

function diagnosticCode(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,128}$/.test(code)
    ? code
    : "UNCLASSIFIED";
}

function diagnosticSummary(error: unknown): string {
  const code = diagnosticCode(error);
  if (code !== "SCENARIO_MANIFEST_READBACK_INCOMPLETE") return code;
  const message = error instanceof Error ? error.message : "";
  const counts = message.match(/\{["A-Za-z0-9/:,]+\}$/)?.[0];
  return counts ? `${code}:${counts}` : code;
}

async function syncReceiptDirectory(): Promise<void> {
  const directory = await open(path.dirname(receiptPath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readReceipt(): Promise<ProductionManifestReceipt | null> {
  let handle: FileHandle;
  try {
    handle = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // error-policy:J3 Only an absent receipt is the explicit empty state.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_RECEIPT_BYTES)
    ) {
      throw new Error(
        "production receipt artifact is not a bounded regular file",
      );
    }
    if (receiptReadDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, receiptReadDelayMs));
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new Error(
          "production receipt artifact was truncated during read",
        );
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(receiptPath, { bigint: true });
    const sameIdentity =
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs &&
      after.dev === pathAfter.dev &&
      after.ino === pathAfter.ino &&
      after.size === pathAfter.size &&
      pathAfter.nlink === 1n;
    if (!sameIdentity) {
      throw new Error("production receipt artifact changed during read");
    }
    return parseProductionManifestReceipt(JSON.parse(bytes.toString("utf8")));
  } finally {
    await handle.close();
  }
}

async function writeReceipt(receipt: ProductionManifestReceipt): Promise<void> {
  const bytes = `${serializeProductionManifestArtifact(receipt)}\n`;
  if (Buffer.byteLength(bytes, "utf8") > MAX_RECEIPT_BYTES) {
    throw new Error("production receipt artifact exceeds its byte limit");
  }
  const temporaryPath = `${receiptPath}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, receiptPath);
    await syncReceiptDirectory();
  } finally {
    await handle?.close();
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      // error-policy:J6 A stranded exclusive temp is observable but cannot mask the primary result.
      process.stderr.write(`receipt temp cleanup failed: ${String(error)}\n`);
    }
  }
}

async function activeAuthority(
  context: SyntheticControlExecutionContext,
): Promise<SyntheticEnvironmentLeaseAuthority> {
  const snapshot = await leaseStore.read(namespace);
  if (
    context.expectedGeneration !== snapshot?.generation ||
    context.leaseId !== snapshot.leaseId
  ) {
    throw new SyntheticControlProtocolError({
      code:
        context.expectedGeneration !== snapshot?.generation
          ? "STALE_GENERATION"
          : "LEASE_REQUIRED",
      message: "the active controller lease and generation are required",
      retryable: true,
      generation: snapshot?.generation,
    });
  }
  if (snapshot.status !== "active" || !snapshot.leaseId || !snapshot.owner) {
    throw new SyntheticControlProtocolError({
      code: "LEASE_REQUIRED",
      message: "the controller lease is not active",
      retryable: true,
      generation: snapshot?.generation,
    });
  }
  return {
    version: 1,
    namespace,
    generation: snapshot.generation,
    leaseId: snapshot.leaseId,
    owner: snapshot.owner,
  };
}

function generationFence(authority: SyntheticEnvironmentLeaseAuthority) {
  return {
    async withGeneration<T>(
      expectedGeneration: string,
      operation: (guard: { isCurrent(): Promise<boolean> }) => Promise<T>,
    ): Promise<T> {
      if (expectedGeneration !== String(authority.generation)) {
        throw new SyntheticControlProtocolError({
          code: "STALE_GENERATION",
          message: "boundary generation does not match the active lease",
          generation: authority.generation,
        });
      }
      const guarded = await leaseStore.withActiveGeneration(
        authority,
        async (database) =>
          operation({
            isCurrent: async () => {
              const row = database
                .query(
                  "SELECT generation, lease_id FROM synthetic_environment_leases WHERE namespace = ?",
                )
                .get(namespace) as {
                generation: number;
                lease_id: string | null;
              } | null;
              return (
                row?.generation === authority.generation &&
                row.lease_id === authority.leaseId
              );
            },
          }),
      );
      return guarded.value;
    },
  };
}

function commandFault(type: string): SyntheticFault | undefined {
  return [...faults.values()].find(
    (fault) =>
      fault.count > 0 &&
      fault.scope === "production-control" &&
      (fault.operation === undefined || fault.operation === type),
  );
}

async function applyDelay(
  fault: SyntheticFault | undefined,
  signal: AbortSignal,
) {
  if (fault?.mode !== "delay") return;
  fault.count -= 1;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, fault.delayMs ?? 100);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function observeWrite<TResponse, TReadback>(options: {
  authority: SyntheticEnvironmentLeaseAuthority;
  commandId: string;
  surface: string;
  payload: unknown;
  invoke: () => Promise<TResponse>;
  readback: () => Promise<TReadback | null>;
  verifyReadback: (response: TResponse, readback: TReadback) => boolean;
}): Promise<{ observation: JsonValue; response: TResponse }> {
  let response: TResponse | undefined;
  const observation = await observeProductionBoundary({
    ledger,
    identity: {
      tenantId: runtime.agentId,
      runId: namespace,
      surface: options.surface,
      target: namespace,
      idempotencyKey: options.commandId,
      generation: String(options.authority.generation),
      workerId: `pid:${process.pid}`,
      retry: { attempt: 1 },
    },
    payload: options.payload,
    now: () => new Date(clock.now()),
    generationFence: generationFence(options.authority),
    invoke: async () => {
      response = await options.invoke();
      return response;
    },
    classify: () => ({ acceptance: "accepted", code: "ok", retryable: false }),
    readback: options.readback,
    verifyReadback: options.verifyReadback,
  });
  if (observation.result !== "succeeded" || response === undefined) {
    throw new Error(`production boundary ${options.surface} did not succeed`);
  }
  return {
    observation: observation as unknown as JsonValue,
    response,
  };
}

class ProductionAuthority implements SyntheticControlAuthority {
  onTeardown: (() => void) | null = null;

  async generation(): Promise<number> {
    return (await leaseStore.read(namespace))?.generation ?? 0;
  }

  async execute(
    command: SyntheticControlCommand,
    context: SyntheticControlExecutionContext,
  ): Promise<JsonValue> {
    if (command.type === "health") {
      const taskService = runtime.getService(ServiceType.TASK);
      if (!(taskService instanceof TaskService)) {
        throw new Error("real TaskService is unavailable");
      }
      await taskService.waitForQuiescence();
      const pending = taskService.pendingWorkCount();
      return {
        status: "ready",
        pid: process.pid,
        agentId: runtime.agentId,
        pgliteDir,
        pending,
        ambientSentinelPresent:
          process.env.SYNTHETIC_AMBIENT_SECRET_SENTINEL !== undefined,
        taskEffect: await readTaskEffect(),
        capabilities: [
          "production-manifest",
          "persistent-pglite",
          "lease-generation",
          "boundary-ledger",
          "virtual-time",
          "teardown",
        ],
      };
    }
    if (command.type === "lease.acquire") {
      if (context.expectedGeneration !== (await this.generation())) {
        throw new SyntheticControlProtocolError({
          code: "STALE_GENERATION",
          message: "lease acquire expected generation is stale",
          retryable: true,
        });
      }
      const acquired = await leaseStore.acquire({
        namespace,
        owner: { ownerId: command.owner, processId: null, host: hostname() },
        leaseDurationMs: command.ttlMs,
      });
      return {
        leaseId: acquired.authority.leaseId,
        expiresAt: acquired.snapshot.expiresAt,
        authority: acquired.authority,
      } as unknown as JsonValue;
    }

    const authority = await activeAuthority(context);
    if (command.type === "lease.release") {
      if (command.leaseId !== authority.leaseId) {
        throw new SyntheticControlProtocolError({
          code: "LEASE_REQUIRED",
          message: "lease release requires the active lease id",
        });
      }
      const released = await leaseStore.release(authority);
      return {
        released: true,
        snapshot: released.snapshot,
      } as unknown as JsonValue;
    }
    if (command.type === "fault.install") {
      await leaseStore.withActiveGeneration(authority, async () => {
        faults.set(command.fault.id, structuredClone(command.fault));
      });
      return { installed: command.fault.id };
    }
    if (command.type === "fault.clear") {
      await leaseStore.withActiveGeneration(authority, async () => {
        for (const [id, fault] of faults) {
          if (!command.scope || fault.scope === command.scope)
            faults.delete(id);
        }
      });
      return { cleared: true };
    }
    const fault = commandFault(command.type);
    await applyDelay(fault, context.signal);
    if (fault?.mode === "error") {
      fault.count -= 1;
      throw new Error(fault.errorCode ?? "scripted production control failure");
    }

    if (command.type === "seed") {
      const productionManifest = command.manifest.domains.productionManifest;
      let appliedReceipt: ProductionManifestReceipt | undefined;
      const result = await observeWrite({
        authority,
        commandId: context.commandId,
        surface: "production-manifest.seed",
        payload: productionManifest,
        invoke: async () => {
          appliedReceipt = await applyProductionManifest(
            runtime,
            productionManifest,
          );
          return appliedReceipt;
        },
        readback: async () =>
          appliedReceipt
            ? readProductionManifestSnapshot(runtime, appliedReceipt)
            : null,
        verifyReadback: (_receipt, snapshot) =>
          snapshot.namespace === namespace,
      });
      const responseReceipt = result.response;
      await writeReceipt(responseReceipt);
      return {
        receipt: {
          version: 1,
          namespace,
          manifestId: command.manifest.manifestId,
          generation: authority.generation,
          receipt: responseReceipt,
        },
        observation: result.observation,
      } as unknown as JsonValue;
    }
    if (command.type === "snapshot") {
      const receipt = await readReceipt();
      try {
        return receipt
          ? ({
              receipt,
              snapshot: await readProductionManifestSnapshot(runtime, receipt),
              taskEffect: await readTaskEffect(),
              logicalTimeMs: clock.now(),
            } as unknown as JsonValue)
          : {
              receipt: null,
              snapshot: null,
              taskEffect: await readTaskEffect(),
              logicalTimeMs: clock.now(),
            };
      } catch (error) {
        // error-policy:J2 Emit only the typed code; the authenticated handler owns redaction.
        process.stderr.write(`snapshot failed: ${diagnosticSummary(error)}\n`);
        throw error;
      }
    }
    if (command.type === "reset") {
      if (command.receipt.generation !== authority.generation) {
        throw new SyntheticControlProtocolError({
          code: "STALE_GENERATION",
          message: "reset receipt belongs to a stale generation",
          generation: authority.generation,
        });
      }
      const productionReceipt = parseProductionManifestReceipt(
        command.receipt.receipt,
      );
      const result = await observeWrite({
        authority,
        commandId: context.commandId,
        surface: "production-manifest.reset",
        payload: productionReceipt,
        invoke: () => resetProductionManifest(runtime, productionReceipt),
        readback: async () => {
          const worlds = await runtime.getWorldsByIds([
            productionReceipt.worldId,
          ]);
          return { absent: worlds.length === 0 };
        },
        verifyReadback: (_artifact, readback) => readback.absent,
      });
      try {
        await unlink(receiptPath);
        await syncReceiptDirectory();
      } catch (error) {
        // error-policy:J3 Reset owns the receipt; only an already-absent artifact is acceptable.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        reset: result.response,
        observation: result.observation,
      } as unknown as JsonValue;
    }
    if (command.type === "time.advance") {
      const result = await observeWrite({
        authority,
        commandId: context.commandId,
        surface: "task-service.time.advance",
        payload: { milliseconds: command.milliseconds },
        invoke: async () => {
          await clock.advance(command.milliseconds);
          const taskService = runtime.getService(ServiceType.TASK);
          if (!(taskService instanceof TaskService)) {
            throw new Error("real TaskService is unavailable");
          }
          await taskService.waitForQuiescence();
          return {
            logicalTimeMs: clock.now(),
            pending: taskService.pendingWorkCount(),
            taskEffect: await readTaskEffect(),
          };
        },
        readback: async () => {
          const taskService = runtime.getService(ServiceType.TASK);
          if (!(taskService instanceof TaskService)) return null;
          return {
            logicalTimeMs: clock.now(),
            pending: taskService.pendingWorkCount(),
            taskEffect: await readTaskEffect(),
          };
        },
        verifyReadback: (response, readback) =>
          response.logicalTimeMs === readback.logicalTimeMs &&
          JSON.stringify(response.taskEffect) ===
            JSON.stringify(readback.taskEffect) &&
          readback.pending === 0,
      });
      return {
        ...result.response,
        observation: result.observation,
      } as JsonValue;
    }
    if (command.type === "ledger.query") {
      const entries = await ledger.readAll();
      const after = command.afterSequence ?? 0;
      const limit = command.limit ?? 100;
      return {
        entries: entries.slice(after, after + limit),
        nextSequence: Math.min(entries.length, after + limit),
      } as unknown as JsonValue;
    }
    if (command.type === "teardown") {
      const taskService = runtime.getService(ServiceType.TASK);
      if (!(taskService instanceof TaskService)) {
        throw new Error("real TaskService is unavailable");
      }
      await taskService.waitForQuiescence();
      const pending = taskService.pendingWorkCount();
      const released = await leaseStore.release(authority);
      setTimeout(() => this.onTeardown?.(), 10);
      return {
        accepted: true,
        leaseReleased: released.snapshot.status === "released",
        pending,
      };
    }
    throw new SyntheticControlProtocolError({
      code: "UNSUPPORTED_COMMAND",
      message: "production authority received an unsupported command",
    });
  }
}

const authority = new ProductionAuthority();
const handler = createSyntheticControlHandler({ namespace, token, authority });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) =>
    (await handler(request)) ?? new Response("not found", { status: 404 }),
});

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.stop(true);
  await runtimeHost.cleanup();
  descendant?.kill("SIGTERM");
  leaseStore.close();
  process.exit(exitCode);
}

authority.onTeardown = () => void stop(0);
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  void stop(1);
});
process.on("unhandledRejection", (error) => {
  process.stderr.write(`${String(error)}\n`);
  void stop(1);
});

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    url: server.url.toString(),
    pid: process.pid,
    agentId: runtime.agentId,
    pgliteDir,
    descendantPid: descendant?.pid ?? null,
  })}\n`,
);
if (emitLogBytes > 0) {
  setTimeout(() => process.stderr.write("x".repeat(emitLogBytes)), 25);
}
