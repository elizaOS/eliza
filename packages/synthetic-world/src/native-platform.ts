/**
 * Provides a deterministic native-host boundary that production JavaScript
 * bridge clients can call in keyless tests without representing simulator
 * receipts as device certification.
 */
import { payloadHash } from "./canonical.ts";
import type { JsonValue } from "./manifest.ts";
import type { SyntheticWorld } from "./world.ts";

export const NATIVE_PLATFORM_ADAPTER_VERSION =
  "eliza.synthetic-native-platform/v1" as const;

export type NativePermission = "granted" | "denied" | "prompt";

export class SyntheticNativePlatformError extends Error {
  public constructor(
    public readonly code:
      | "aborted"
      | "invalid-input"
      | "permission-denied"
      | "platform-unavailable"
      | "surface-unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SyntheticNativePlatformError";
  }
}

export interface NativeInvocation {
  readonly surfaceId: string;
  readonly method: string;
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export interface NativeHandlerContext {
  readonly generation: number;
  readonly now: Date;
  readonly permission: NativePermission;
  readonly state: JsonValue;
  setState(value: JsonValue): void;
  sleep(durationMs: number): Promise<void>;
  emit(event: string, payload: JsonValue): void;
}

export type NativeHandler = (
  input: JsonValue,
  context: NativeHandlerContext,
) => JsonValue | Promise<JsonValue>;

export interface NativeSurfaceDefinition {
  readonly id: string;
  readonly available?: boolean;
  readonly permission?: NativePermission;
  readonly initialState?: JsonValue;
  readonly handlers: Readonly<Record<string, NativeHandler>>;
}

export interface NativePlatformReadback {
  readonly schema: typeof NATIVE_PLATFORM_ADAPTER_VERSION;
  readonly namespace: string;
  readonly generation: number;
  readonly stateHash: string;
  readonly surfaces: Readonly<Record<string, JsonValue>>;
  readonly queuedEvents: number;
  readonly inFlight: number;
  readonly idempotentResults: number;
  readonly certification: "synthetic-simulator-only";
}

type EventListener = (payload: JsonValue) => void;

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9@._:/-]{1,256}$/.test(value)) {
    throw new SyntheticNativePlatformError(
      "invalid-input",
      `${label} must be a bounded native boundary identifier`,
    );
  }
}

function abortError(): SyntheticNativePlatformError {
  return new SyntheticNativePlatformError("aborted", "Native call aborted");
}

export class SyntheticNativePlatform {
  private readonly definitions = new Map<string, NativeSurfaceDefinition>();
  private readonly initialState = new Map<string, JsonValue>();
  private readonly state = new Map<string, JsonValue>();
  private readonly permissions = new Map<string, NativePermission>();
  private readonly available = new Map<string, boolean>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly eventQueue: Array<{
    surfaceId: string;
    event: string;
    payload: JsonValue;
  }> = [];
  private readonly idempotentResults = new Map<string, JsonValue>();
  private readonly inFlight = new Set<AbortController>();
  private generation = 1;
  private closed = false;

  public constructor(
    private readonly world: SyntheticWorld,
    definitions: readonly NativeSurfaceDefinition[],
  ) {
    for (const definition of definitions) {
      assertIdentifier(definition.id, "surface id");
      if (this.definitions.has(definition.id)) {
        throw new Error(`Duplicate native surface ${definition.id}`);
      }
      const seeded = structuredClone(definition.initialState ?? null);
      this.definitions.set(definition.id, definition);
      this.initialState.set(definition.id, seeded);
      this.state.set(definition.id, structuredClone(seeded));
      this.permissions.set(definition.id, definition.permission ?? "granted");
      this.available.set(definition.id, definition.available ?? true);
    }
  }

  public async invoke(invocation: NativeInvocation): Promise<JsonValue> {
    this.assertOpen();
    assertIdentifier(invocation.surfaceId, "surface id");
    assertIdentifier(invocation.method, "method");
    const definition = this.definitions.get(invocation.surfaceId);
    if (!definition) {
      throw new SyntheticNativePlatformError(
        "surface-unavailable",
        `Unknown native surface ${invocation.surfaceId}`,
      );
    }
    const handler = definition.handlers[invocation.method];
    if (invocation.signal?.aborted) throw abortError();

    const idempotencyCacheKey = invocation.idempotencyKey
      ? `${invocation.surfaceId}:${invocation.method}:${invocation.idempotencyKey}`
      : undefined;
    const cachedResult = idempotencyCacheKey
      ? this.idempotentResults.get(idempotencyCacheKey)
      : undefined;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    invocation.signal?.addEventListener("abort", onAbort, { once: true });
    this.inFlight.add(controller);
    const boundary = `native.${invocation.surfaceId}.${invocation.method}`;
    try {
      const result = await this.world.executeBoundary(boundary, {
        input: invocation.input,
        idempotencyKey: invocation.idempotencyKey,
        execute: async () => {
          if (controller.signal.aborted) throw abortError();
          if (!this.available.get(invocation.surfaceId)) {
            throw new SyntheticNativePlatformError(
              "platform-unavailable",
              `Native surface ${invocation.surfaceId} is unavailable`,
            );
          }
          if (this.permissions.get(invocation.surfaceId) === "denied") {
            throw new SyntheticNativePlatformError(
              "permission-denied",
              `Permission denied for native surface ${invocation.surfaceId}`,
            );
          }
          if (!handler) {
            throw new SyntheticNativePlatformError(
              "invalid-input",
              `Unknown method ${invocation.method} on ${invocation.surfaceId}`,
            );
          }
          if (cachedResult !== undefined) return structuredClone(cachedResult);
          return handler(structuredClone(invocation.input), {
            generation: this.generation,
            now: this.world.clock.now(),
            permission: this.permissions.get(invocation.surfaceId) ?? "prompt",
            state: structuredClone(
              this.state.get(invocation.surfaceId) ?? null,
            ),
            setState: (value) => {
              if (controller.signal.aborted) throw abortError();
              this.state.set(invocation.surfaceId, structuredClone(value));
            },
            sleep: (durationMs) => this.sleep(durationMs, controller.signal),
            emit: (event, payload) => {
              assertIdentifier(event, "event");
              if (controller.signal.aborted) throw abortError();
              this.eventQueue.push({
                surfaceId: invocation.surfaceId,
                event,
                payload: structuredClone(payload),
              });
            },
          });
        },
        authoritativeReadback: () => this.readback() as unknown as JsonValue,
      });
      if (idempotencyCacheKey && cachedResult === undefined) {
        this.idempotentResults.set(
          idempotencyCacheKey,
          structuredClone(result),
        );
      }
      return structuredClone(result);
    } finally {
      invocation.signal?.removeEventListener("abort", onAbort);
      this.inFlight.delete(controller);
    }
  }

  public subscribe(
    surfaceId: string,
    event: string,
    listener: EventListener,
  ): () => void {
    this.assertOpen();
    assertIdentifier(surfaceId, "surface id");
    assertIdentifier(event, "event");
    const key = `${surfaceId}:${event}`;
    const group = this.listeners.get(key) ?? new Set<EventListener>();
    group.add(listener);
    this.listeners.set(key, group);
    return () => group.delete(listener);
  }

  public flushEvents(): number {
    this.assertOpen();
    let delivered = 0;
    for (const queued of this.eventQueue.splice(0)) {
      for (const listener of this.listeners.get(
        `${queued.surfaceId}:${queued.event}`,
      ) ?? []) {
        listener(structuredClone(queued.payload));
        delivered += 1;
      }
      this.world.ledger.append({
        kind: "notification",
        status: "observed",
        target: `native.${queued.surfaceId}.event.${queued.event}`,
        attempt: 1,
        output: queued.payload,
        payloadHash: payloadHash(queued.payload),
      });
    }
    return delivered;
  }

  public setPermission(surfaceId: string, permission: NativePermission): void {
    this.assertKnown(surfaceId);
    this.permissions.set(surfaceId, permission);
  }

  public setAvailable(surfaceId: string, available: boolean): void {
    this.assertKnown(surfaceId);
    this.available.set(surfaceId, available);
  }

  public restart(): NativePlatformReadback {
    this.assertOpen();
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.eventQueue.length = 0;
    this.listeners.clear();
    this.generation += 1;
    return this.readback();
  }

  public reset(): NativePlatformReadback {
    this.assertOpen();
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.eventQueue.length = 0;
    this.listeners.clear();
    this.idempotentResults.clear();
    this.generation = 1;
    for (const [surfaceId, value] of this.initialState) {
      this.state.set(surfaceId, structuredClone(value));
      const definition = this.definitions.get(surfaceId);
      this.permissions.set(surfaceId, definition?.permission ?? "granted");
      this.available.set(surfaceId, definition?.available ?? true);
    }
    this.world.reset();
    return this.readback();
  }

  public readback(): NativePlatformReadback {
    this.assertOpen();
    const surfaces = Object.fromEntries(
      [...this.state.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, value]) => [id, structuredClone(value)]),
    );
    return {
      schema: NATIVE_PLATFORM_ADAPTER_VERSION,
      namespace: this.world.namespace,
      generation: this.generation,
      stateHash: payloadHash(surfaces as JsonValue),
      surfaces,
      queuedEvents: this.eventQueue.length,
      inFlight: this.inFlight.size,
      idempotentResults: this.idempotentResults.size,
      certification: "synthetic-simulator-only",
    };
  }

  public teardown(): void {
    if (this.closed) return;
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.eventQueue.length = 0;
    this.listeners.clear();
    this.idempotentResults.clear();
    this.state.clear();
    this.closed = true;
  }

  private sleep(durationMs: number, signal: AbortSignal): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new SyntheticNativePlatformError(
        "invalid-input",
        "Native delay must be a non-negative finite number",
      );
    }
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timerId = this.world.clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, durationMs);
      const onAbort = () => {
        this.world.clock.clearTimeout(timerId);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private assertKnown(surfaceId: string): void {
    this.assertOpen();
    if (!this.definitions.has(surfaceId)) {
      throw new SyntheticNativePlatformError(
        "surface-unavailable",
        `Unknown native surface ${surfaceId}`,
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Synthetic native platform is torn down");
  }
}
