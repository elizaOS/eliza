/**
 * Owns one isolated synthetic world's deterministic lifecycle while delegating
 * scheduling, persistence, queues, and provider behavior to injected systems.
 */
import { DeterministicRandom, payloadHash } from "./canonical.ts";
import { VirtualClock } from "./clock.ts";
import { FaultController, SyntheticFaultError } from "./faults.ts";
import { ObservationLedger } from "./ledger.ts";
import {
  type FaultEffect,
  type JsonValue,
  parseWorldManifest,
  type WorldData,
  type WorldManifest,
} from "./manifest.ts";
import { acquireNamespace, type NamespaceLease } from "./namespace.ts";

export interface WorldStateSnapshot {
  /**
   * Restoring state resets timers, fault attempts, and the seeded random stream;
   * production schedulers rehydrate their callbacks from the restored data.
   */
  readonly semantics: "state-and-clock-reset-execution";
  readonly schemaVersion: WorldManifest["schemaVersion"];
  readonly worldId: string;
  readonly seed: string;
  readonly capturedAt: string;
  readonly data: WorldData;
  readonly stateHash: string;
}

export type WorldSnapshot = WorldStateSnapshot;

export interface BoundaryExecutionOptions<T extends JsonValue> {
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
  readonly execute: () => Promise<T> | T;
  readonly authoritativeReadback?: () => Promise<JsonValue> | JsonValue;
}

function omitFields(value: JsonValue, fields: readonly string[]): JsonValue {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    return value;
  const copy = structuredClone(value);
  for (const field of fields) delete copy[field];
  return copy;
}

export class SyntheticWorld {
  public readonly clock: VirtualClock;
  public readonly ledger: ObservationLedger;
  public random: DeterministicRandom;

  private readonly lease: NamespaceLease;
  private readonly initialManifest: WorldManifest;
  private faults: FaultController;
  private currentData: WorldData;
  private closed = false;

  public constructor(
    manifestInput: WorldManifest,
    public readonly namespace: string,
  ) {
    this.initialManifest = parseWorldManifest(manifestInput);
    this.lease = acquireNamespace(namespace);
    this.currentData = structuredClone(this.initialManifest.data);
    this.clock = new VirtualClock(
      this.initialManifest.clock.epoch,
      this.initialManifest.clock.timezone,
    );
    this.ledger = new ObservationLedger(namespace, () => this.clock.nowIso());
    this.random = new DeterministicRandom(this.initialManifest.seed);
    this.faults = new FaultController(this.initialManifest.faults);
    this.ledger.append({
      kind: "lifecycle",
      status: "observed",
      target: "world.boot",
      attempt: 1,
      payloadHash: this.stateHash,
    });
  }

  public get manifest(): WorldManifest {
    return structuredClone({ ...this.initialManifest, data: this.currentData });
  }

  public get data(): WorldData {
    this.assertOpen();
    return structuredClone(this.currentData);
  }

  public get stateHash(): string {
    return payloadHash(this.currentData as unknown as JsonValue);
  }

  public snapshot(): WorldStateSnapshot {
    this.assertOpen();
    return {
      semantics: "state-and-clock-reset-execution",
      schemaVersion: this.initialManifest.schemaVersion,
      worldId: this.initialManifest.worldId,
      seed: this.initialManifest.seed,
      capturedAt: this.clock.nowIso(),
      data: this.data,
      stateHash: this.stateHash,
    };
  }

  public updateData(update: (draft: WorldData) => void): string {
    this.assertOpen();
    const before = this.currentData as unknown as JsonValue;
    const draft = structuredClone(this.currentData);
    update(draft);
    this.currentData = parseWorldManifest({
      ...this.initialManifest,
      data: draft,
    }).data;
    this.ledger.append({
      kind: "state-transition",
      status: "committed",
      target: "world.data",
      attempt: 1,
      payloadHash: this.stateHash,
      stateTransition: {
        from: before,
        to: this.currentData as unknown as JsonValue,
      },
    });
    return this.stateHash;
  }

  public reset(): void {
    this.assertOpen();
    this.currentData = structuredClone(this.initialManifest.data);
    this.clock.reset(this.initialManifest.clock.epoch);
    this.random = new DeterministicRandom(this.initialManifest.seed);
    this.faults.reset();
    this.ledger.clear();
  }

  public restore(snapshot: WorldStateSnapshot): void {
    this.assertOpen();
    if (
      snapshot.semantics !== "state-and-clock-reset-execution" ||
      snapshot.schemaVersion !== this.initialManifest.schemaVersion ||
      snapshot.worldId !== this.initialManifest.worldId ||
      snapshot.seed !== this.initialManifest.seed
    ) {
      throw new Error("Snapshot does not belong to this synthetic world");
    }
    const data = parseWorldManifest({
      ...this.initialManifest,
      data: snapshot.data,
    }).data;
    const restoredHash = payloadHash(data as unknown as JsonValue);
    if (restoredHash !== snapshot.stateHash)
      throw new Error("Snapshot state hash does not match its data");
    this.currentData = data;
    this.clock.reset(snapshot.capturedAt);
    this.random = new DeterministicRandom(this.initialManifest.seed);
    this.faults.reset();
    this.ledger.clear();
  }

  public async executeBoundary<T extends JsonValue>(
    boundary: string,
    options: BoundaryExecutionOptions<T>,
  ): Promise<T> {
    this.assertOpen();
    const { attempt, effect } = this.faults.next(boundary);
    const hash = payloadHash(options.input);
    this.ledger.append({
      kind: "request",
      status: "started",
      target: boundary,
      input: options.input,
      payloadHash: hash,
      idempotencyKey: options.idempotencyKey,
      attempt,
    });
    if (effect) {
      this.ledger.append({
        kind: "fault",
        status: "observed",
        target: boundary,
        input: effect as unknown as JsonValue,
        payloadHash: payloadHash(effect as unknown as JsonValue),
        idempotencyKey: options.idempotencyKey,
        attempt,
      });
    }

    try {
      const early = await this.applyPreExecutionFault(
        boundary,
        attempt,
        effect,
      );
      if (early !== undefined) {
        this.ledger.append({
          kind: "response",
          status: "succeeded",
          target: boundary,
          output: early,
          payloadHash: hash,
          idempotencyKey: options.idempotencyKey,
          attempt,
        });
        return early as T;
      }
      const output = await options.execute();
      const transformed =
        effect?.kind === "partialResponse"
          ? omitFields(output, effect.omitFields)
          : output;
      const readback = options.authoritativeReadback
        ? await options.authoritativeReadback()
        : undefined;
      this.ledger.append({
        kind: "response",
        status: "succeeded",
        target: boundary,
        output: transformed,
        payloadHash: hash,
        idempotencyKey: options.idempotencyKey,
        attempt,
        authoritativeReadback: readback,
      });
      if (readback !== undefined) {
        this.ledger.append({
          kind: "readback",
          status: "observed",
          target: boundary,
          output: readback,
          payloadHash: payloadHash(readback),
          idempotencyKey: options.idempotencyKey,
          attempt,
        });
      }
      if (effect?.kind === "ambiguousCommit")
        throw new SyntheticFaultError(boundary, attempt, effect);
      return transformed as T;
    } catch (error) {
      // error-policy:J2 Boundary failures retain their typed cause for the caller.
      this.ledger.append({
        kind:
          effect?.kind === "retry" || effect?.kind === "rateLimit"
            ? "retry"
            : "response",
        status: "failed",
        target: boundary,
        output: {
          error: error instanceof Error ? error.message : String(error),
        },
        payloadHash: hash,
        idempotencyKey: options.idempotencyKey,
        attempt,
      });
      throw error;
    }
  }

  public teardown(): void {
    if (this.closed) return;
    this.clock.reset(this.initialManifest.clock.epoch);
    this.faults.reset();
    this.ledger.clear();
    this.closed = true;
    this.lease.release();
  }

  private async applyPreExecutionFault(
    boundary: string,
    attempt: number,
    effect: FaultEffect | undefined,
  ): Promise<JsonValue | undefined> {
    if (
      !effect ||
      effect.kind === "recovery" ||
      effect.kind === "partialResponse" ||
      effect.kind === "ambiguousCommit"
    ) {
      return undefined;
    }
    if (effect.kind === "latency") {
      await this.clock.advanceBy(effect.durationMs);
      return undefined;
    }
    if (effect.kind === "timeout")
      await this.clock.advanceBy(effect.durationMs);
    if (effect.kind === "malformedData") return effect.value;
    throw new SyntheticFaultError(boundary, attempt, effect);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Synthetic world has been torn down");
  }
}
