/** Owns one leased scenario's API mocks, fault schedule and complete request ledger. */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SyntheticEnvironmentLeaseAuthority,
  SyntheticEnvironmentLeaseStore,
} from "@elizaos/contracts";
import { ElizaError } from "@elizaos/core";
import {
  MOCK_ENVIRONMENTS,
  type MockEnvironmentName,
  type MockRequestLedgerEntry,
  type StartedMocks,
  startMocks,
} from "../../scripts/mocks/start-mocks.ts";
import {
  assertJsonValue,
  parseSyntheticControlRequest,
} from "../../src/synthetic-control/codec.ts";
import type {
  JsonValue,
  SyntheticFault,
  SyntheticManifest,
} from "../../src/synthetic-control/types.ts";

export interface SyntheticSeedRequest {
  service: MockEnvironmentName;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: JsonValue;
}

export interface SyntheticScenarioWorldOptions<T> {
  manifest: SyntheticManifest;
  leaseStore: SyntheticEnvironmentLeaseStore<T>;
  /** Control sessions may supply their already-acquired lease and retain release ownership. */
  authority?: SyntheticEnvironmentLeaseAuthority;
  signal?: AbortSignal;
  /** Cancel initialization without binding a ready world to its seed request. */
  initializationSignal?: AbortSignal;
  leaseDurationMs?: number;
}

export interface SyntheticScenarioWorld {
  readonly namespace: string;
  readonly authority: SyntheticEnvironmentLeaseAuthority;
  readonly settings: Readonly<Record<string, string>>;
  readonly endpoints: Readonly<Partial<Record<MockEnvironmentName, string>>>;
  readonly signal: AbortSignal;
  requestLedger(): readonly MockRequestLedgerEntry[];
  snapshot(): JsonValue;
  installFault(fault: SyntheticFault): Promise<void>;
  clearFaults(scope?: string): Promise<void>;
  assertComplete(): void;
  close(): Promise<void>;
}

function invalid(message: string): never {
  throw new ElizaError(message, { code: "SYNTHETIC_WORLD_INVALID_MANIFEST" });
}

function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Manifest domain keys name registered services; each domain may declare seed requests. */
export function parseSyntheticScenarioManifest(manifest: SyntheticManifest): {
  services: MockEnvironmentName[];
  seeds: SyntheticSeedRequest[];
} {
  parseSyntheticControlRequest({
    version: 1,
    namespace: manifest.namespace,
    commandId: "world-preflight",
    command: { type: "seed", manifest },
  });
  const services: MockEnvironmentName[] = [];
  const seeds: SyntheticSeedRequest[] = [];
  for (const [name, value] of Object.entries(manifest.domains)) {
    if (!MOCK_ENVIRONMENTS.includes(name as MockEnvironmentName))
      invalid(`Unsupported synthetic API service: ${name}`);
    const service = name as MockEnvironmentName;
    services.push(service);
    if (!isJsonObject(value))
      invalid(`Service ${name} configuration must be an object`);
    if (Object.keys(value).some((key) => key !== "seed"))
      invalid(`Unknown configuration for service ${name}`);
    const seed = value.seed ?? [];
    if (!Array.isArray(seed)) invalid(`Service ${name} seed must be an array`);
    for (const item of seed) {
      if (!isJsonObject(item)) invalid(`Invalid ${name} seed request`);
      if (
        Object.keys(item).some(
          (key) => !["method", "path", "body"].includes(key),
        )
      )
        invalid(`Unknown ${name} seed field`);
      if (
        typeof item.method !== "string" ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(item.method)
      )
        invalid(`Invalid ${name} seed method`);
      if (
        typeof item.path !== "string" ||
        !item.path.startsWith("/") ||
        item.path.startsWith("//") ||
        item.path.includes("\\")
      )
        invalid(`Seed paths must stay on the ${name} mock origin`);
      if (item.method === "GET" && item.body !== undefined)
        invalid("GET seed requests cannot have a body");
      seeds.push({
        service,
        method: item.method as SyntheticSeedRequest["method"],
        path: item.path,
        ...(item.body !== undefined ? { body: item.body } : {}),
      });
    }
  }
  if (services.length === 0)
    invalid("A synthetic world must declare at least one API service");
  return { services, seeds };
}

/** Uses the existing lease store; API effects never claim atomicity with a separate domain database. */
export async function startSyntheticScenarioWorld<T>(
  options: SyntheticScenarioWorldOptions<T>,
): Promise<SyntheticScenarioWorld> {
  const { services, seeds } = parseSyntheticScenarioManifest(options.manifest);
  options.signal?.throwIfAborted();
  options.initializationSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const initializationSignal = options.initializationSignal
    ? AbortSignal.any([signal, options.initializationSignal])
    : signal;
  const leaseDurationMs = options.leaseDurationMs ?? 300_000;
  if (
    options.authority &&
    options.authority.namespace !== options.manifest.namespace
  )
    invalid("World and supplied lease namespaces must match");
  const authority =
    options.authority ??
    (
      await options.leaseStore.acquire({
        namespace: options.manifest.namespace,
        owner: {
          ownerId: `scenario-${randomUUID()}`,
          processId: process.pid,
          host: hostname(),
        },
        leaseDurationMs,
      })
    ).authority;
  let mocks: StartedMocks | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  let heartbeatFailure: unknown;
  let heartbeatWork: Promise<void> = Promise.resolve();
  const faults: SyntheticFault[] = [];
  let activeRequestSignal = signal;
  const heartbeat = setInterval(
    () => {
      heartbeatWork = heartbeatWork.then(async () => {
        if (closing || signal.aborted) return;
        try {
          await options.leaseStore.heartbeat({ authority, leaseDurationMs });
        } catch (error) {
          // error-policy:J2 A lost lease poisons the world and aborts outstanding work.
          heartbeatFailure = error;
          controller.abort(error);
        }
      });
    },
    Math.max(1, Math.floor(leaseDurationMs / 3)),
  );
  heartbeat.unref();
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      clearInterval(heartbeat);
      controller.abort(
        new ElizaError("Synthetic world closed", {
          code: "SYNTHETIC_WORLD_CLOSED",
        }),
      );
      const failures: unknown[] = [];
      for (const cleanup of [
        () => mocks?.stop(),
        () => heartbeatWork,
        () =>
          options.authority ? undefined : options.leaseStore.release(authority),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          // error-policy:J6 Complete resource teardown and preserve each failure.
          failures.push(error);
        }
      }
      if (heartbeatFailure) failures.push(heartbeatFailure);
      if (failures.length)
        throw new AggregateError(failures, "Synthetic world teardown failed");
    })();
    return closePromise;
  };
  try {
    mocks = await startMocks({
      deterministicSeed: `${options.manifest.namespace}:${options.manifest.manifestId}`,
      allowControlMutations: false,
      envs: services,
      withRequest: async (operation) => {
        signal.throwIfAborted();
        const lease = await options.leaseStore.read(authority.namespace);
        const remaining =
          lease?.expiresAt && lease.observedAt
            ? Date.parse(lease.expiresAt) - Date.parse(lease.observedAt)
            : 0;
        if (remaining <= 0)
          throw new ElizaError("Mock request lease has expired", {
            code: "SYNTHETIC_LEASE_LOST",
          });
        const deadline = AbortSignal.timeout(
          Math.max(1, Math.floor(remaining)),
        );
        await options.leaseStore.withActiveGeneration(authority, async () => {
          activeRequestSignal = AbortSignal.any([signal, deadline]);
          activeRequestSignal.throwIfAborted();
          await operation(activeRequestSignal);
        });
      },
      onRequest: async (entry, request, response) => {
        activeRequestSignal.throwIfAborted();
        const fault = faults.find(
          (candidate) =>
            candidate.count > 0 &&
            candidate.scope === entry.service &&
            (!candidate.operation ||
              candidate.operation === `${entry.method} ${entry.path}`),
        );
        if (!fault) return false;
        fault.count -= 1;
        entry.faultId = fault.id;
        if (fault.mode === "delay") {
          const disconnected = new AbortController();
          const abort = () => {
            if (!response.writableFinished) disconnected.abort();
          };
          request.once("aborted", abort);
          response.once("close", abort);
          try {
            await delay(fault.delayMs ?? 0, undefined, {
              signal: AbortSignal.any([
                activeRequestSignal,
                disconnected.signal,
              ]),
            });
          } finally {
            request.off("aborted", abort);
            response.off("close", abort);
          }
          activeRequestSignal.throwIfAborted();
          return false;
        }
        if (fault.mode === "disconnect") {
          response.destroy();
          return true;
        }
        if (fault.mode === "malformed-response") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{");
          return true;
        }
        const data = fault.data;
        const status =
          data !== undefined && isJsonObject(data)
            ? data.statusCode
            : undefined;
        response.writeHead(
          typeof status === "number" &&
            Number.isInteger(status) &&
            status >= 400 &&
            status <= 599
            ? status
            : 503,
          { "content-type": "application/json" },
        );
        response.end(
          JSON.stringify({
            error: fault.errorCode ?? "SYNTHETIC_INJECTED_FAILURE",
          }),
        );
        return true;
      },
    });
    for (const seed of seeds) {
      const base = mocks.baseUrls[seed.service];
      const url = new URL(seed.path, base);
      if (url.origin !== base)
        invalid("Seed request escaped its declared mock origin");
      const response = await fetch(url, {
        method: seed.method,
        headers: { "content-type": "application/json" },
        ...(seed.body !== undefined ? { body: JSON.stringify(seed.body) } : {}),
        redirect: "error",
        signal: initializationSignal,
      });
      await response.arrayBuffer();
      if (!response.ok)
        throw new ElizaError(
          `Seed failed: ${seed.service} ${seed.method} ${seed.path} (${response.status})`,
          { code: "SYNTHETIC_WORLD_SEED_FAILED" },
        );
    }
    initializationSignal.throwIfAborted();
    const owned = mocks;
    const world: SyntheticScenarioWorld = {
      namespace: authority.namespace,
      authority: structuredClone(authority),
      endpoints: Object.freeze({ ...owned.baseUrls }),
      settings: Object.freeze({
        ...owned.envVars,
        ELIZA_SYNTHETIC_WORLD_LEASED: "1",
      }),
      signal,
      requestLedger: () => owned.requestLedger(),
      snapshot: () => {
        const state = owned.snapshot();
        assertJsonValue(state, "synthetic world snapshot");
        return state;
      },
      installFault: async (fault) => {
        signal.throwIfAborted();
        parseSyntheticControlRequest({
          version: 1,
          namespace: authority.namespace,
          commandId: "world-fault-preflight",
          command: { type: "fault.install", fault },
        });
        if (!services.includes(fault.scope as MockEnvironmentName))
          invalid(`Fault scope ${fault.scope} is not a declared service`);
        await options.leaseStore.withActiveGeneration(authority, () => {
          if (faults.some((existing) => existing.id === fault.id))
            invalid(`Duplicate fault ID: ${fault.id}`);
          faults.push(structuredClone(fault));
        });
      },
      clearFaults: async (scope) => {
        signal.throwIfAborted();
        await options.leaseStore.withActiveGeneration(authority, () => {
          for (let index = faults.length - 1; index >= 0; index--)
            if (!scope || faults[index].scope === scope)
              faults.splice(index, 1);
        });
      },
      assertComplete: () => {
        signal.throwIfAborted();
        const unmatched = owned
          .requestLedger()
          .filter((entry) => entry.unmatched);
        const remaining = faults.filter((fault) => fault.count > 0);
        if (unmatched.length || remaining.length)
          throw new ElizaError(
            "Synthetic world has unmatched API requests or unconsumed faults",
            {
              code: "SYNTHETIC_WORLD_INCOMPLETE",
              context: { unmatched, remaining },
            },
          );
      },
      close,
    };
    world.assertComplete();
    return world;
  } catch (error) {
    // error-policy:J6 Failed seeding must release the lease and stop every started service.
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Synthetic world initialization and rollback failed",
      );
    }
    throw error;
  }
}
