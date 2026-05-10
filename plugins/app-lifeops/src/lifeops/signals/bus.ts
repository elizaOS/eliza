/**
 * ActivitySignalBus.
 *
 * Pub/sub fabric for `LifeOpsBusFamily` events. Producers (calendar
 * watcher, plugin-health, time-window emitter, manual-override gateway)
 * publish typed envelopes; consumers (the `ScheduledTaskRunner`'s
 * `ActivitySignalBusView`, plugin-health's recap aggregator) subscribe by
 * family and read recent events.
 *
 * The bus is intentionally narrow. It does NOT:
 *   - Persist events (that is `LifeOpsRepository.insertTelemetryEvent`).
 *   - Replay across restarts (subscribers re-attach on boot).
 *   - Carry payload schemas (consult `FamilyRegistry` for that).
 *
 * It DOES:
 *   - Validate the family against the registered `FamilyRegistry`.
 *   - Buffer recent events per family (24h sliding window) so the read-side
 *     `ActivitySignalBusView.hasSignalSince` works without a DB hit.
 *   - Fan out synchronous subscribers (best-effort) so completion-checks see
 *     events before the runner re-evaluates them.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsBusFamily,
  LifeOpsTelemetryFamily,
} from "@elizaos/shared";
import type { ActivitySignalBusView } from "../scheduled-task/types.js";
import type { ScheduledTaskSubject } from "../scheduled-task/types.js";
import type { FamilyRegistry } from "../registries/family-registry.js";

export interface ActivitySignalEnvelope {
  family: LifeOpsBusFamily;
  occurredAt: string;
  /** Optional subject pointer (used by `hasSignalSince` subject filtering). */
  subject?: ScheduledTaskSubject;
  /**
   * Producer-supplied payload. The bus does not interpret this; consumers
   * that care consult the per-family schema in `FamilyRegistry`.
   */
  payload?: unknown;
  /** Free-form metadata for diagnostics. */
  metadata?: Record<string, unknown>;
}

export interface ActivitySignalBus extends ActivitySignalBusView {
  /** Publish an event to the bus. Validates family membership. */
  publish(envelope: ActivitySignalEnvelope): void;
  /**
   * Subscribe to events of a given family. Returns an unsubscribe fn.
   * Subscribers run synchronously after `publish` and must not throw.
   */
  subscribe(
    family: LifeOpsBusFamily,
    handler: (envelope: ActivitySignalEnvelope) => void,
  ): () => void;
  /**
   * Read events that occurred since the given ISO instant. Optionally
   * narrowed by family or subject.
   */
  recent(args: {
    sinceIso: string;
    family?: LifeOpsBusFamily;
    subject?: ScheduledTaskSubject;
  }): ActivitySignalEnvelope[];
}

export interface CreateActivitySignalBusOptions {
  /**
   * FamilyRegistry the bus consults to validate event families. When unset,
   * the bus accepts any family (degraded mode used in unit tests).
   */
  familyRegistry?: FamilyRegistry;
  /**
   * Sliding-window retention. Older events are evicted on `publish`.
   * Default: 24 hours.
   */
  retentionMs?: number;
  /**
   * Hard cap per family on the number of buffered events. Default: 256.
   */
  maxEventsPerFamily?: number;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS_PER_FAMILY = 256;

class InMemoryActivitySignalBus implements ActivitySignalBus {
  private readonly familyRegistry: FamilyRegistry | null;
  private readonly retentionMs: number;
  private readonly maxEventsPerFamily: number;
  private readonly buffers = new Map<
    LifeOpsBusFamily,
    ActivitySignalEnvelope[]
  >();
  private readonly subscribers = new Map<
    LifeOpsBusFamily,
    Set<(e: ActivitySignalEnvelope) => void>
  >();

  constructor(options: CreateActivitySignalBusOptions) {
    this.familyRegistry = options.familyRegistry ?? null;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxEventsPerFamily =
      options.maxEventsPerFamily ?? DEFAULT_MAX_EVENTS_PER_FAMILY;
  }

  publish(envelope: ActivitySignalEnvelope): void {
    if (!envelope.family) {
      throw new Error("ActivitySignalBus.publish: envelope.family required");
    }
    if (this.familyRegistry && !this.familyRegistry.has(envelope.family)) {
      throw new Error(
        `ActivitySignalBus.publish: family "${envelope.family}" is not registered in FamilyRegistry`,
      );
    }
    if (!envelope.occurredAt) {
      throw new Error(
        "ActivitySignalBus.publish: envelope.occurredAt required",
      );
    }

    const buf = this.buffers.get(envelope.family) ?? [];
    buf.push(envelope);
    this.evictExpired(buf);
    if (buf.length > this.maxEventsPerFamily) {
      buf.splice(0, buf.length - this.maxEventsPerFamily);
    }
    this.buffers.set(envelope.family, buf);

    const handlers = this.subscribers.get(envelope.family);
    if (handlers) {
      for (const handler of handlers) {
        handler(envelope);
      }
    }
  }

  subscribe(
    family: LifeOpsBusFamily,
    handler: (envelope: ActivitySignalEnvelope) => void,
  ): () => void {
    const set = this.subscribers.get(family) ?? new Set();
    set.add(handler);
    this.subscribers.set(family, set);
    return () => {
      const live = this.subscribers.get(family);
      if (!live) return;
      live.delete(handler);
      if (live.size === 0) this.subscribers.delete(family);
    };
  }

  recent(args: {
    sinceIso: string;
    family?: LifeOpsBusFamily;
    subject?: ScheduledTaskSubject;
  }): ActivitySignalEnvelope[] {
    const sinceMs = Date.parse(args.sinceIso);
    if (!Number.isFinite(sinceMs)) {
      throw new Error("ActivitySignalBus.recent: sinceIso must be ISO");
    }
    const buffers = args.family
      ? [this.buffers.get(args.family) ?? []]
      : Array.from(this.buffers.values());
    const events: ActivitySignalEnvelope[] = [];
    for (const buf of buffers) {
      for (const envelope of buf) {
        if (Date.parse(envelope.occurredAt) < sinceMs) continue;
        if (args.subject) {
          if (
            envelope.subject?.kind !== args.subject.kind ||
            envelope.subject?.id !== args.subject.id
          ) {
            continue;
          }
        }
        events.push(envelope);
      }
    }
    return events.sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
    );
  }

  /**
   * Read-side adapter for `ActivitySignalBusView`. The runner uses this on
   * every `completion-check` evaluation; the implementation is a buffer
   * scan, not a DB query, so it stays fast.
   */
  hasSignalSince(args: {
    signalKind: string;
    sinceIso: string;
    subject?: ScheduledTaskSubject;
  }): boolean {
    const recent = this.recent({
      sinceIso: args.sinceIso,
      family: args.signalKind,
      ...(args.subject ? { subject: args.subject } : {}),
    });
    return recent.length > 0;
  }

  private evictExpired(buf: ActivitySignalEnvelope[]): void {
    const cutoff = Date.now() - this.retentionMs;
    while (buf.length > 0) {
      const first = buf[0];
      if (!first) break;
      if (Date.parse(first.occurredAt) >= cutoff) break;
      buf.shift();
    }
  }
}

export function createActivitySignalBus(
  options: CreateActivitySignalBusOptions = {},
): ActivitySignalBus {
  return new InMemoryActivitySignalBus(options);
}

// ---------------------------------------------------------------------------
// Per-runtime binding
// ---------------------------------------------------------------------------

const buses = new WeakMap<IAgentRuntime, ActivitySignalBus>();

export function registerActivitySignalBus(
  runtime: IAgentRuntime,
  bus: ActivitySignalBus,
): void {
  buses.set(runtime, bus);
}

export function getActivitySignalBus(
  runtime: IAgentRuntime,
): ActivitySignalBus | null {
  return buses.get(runtime) ?? null;
}

export function __resetActivitySignalBusForTests(
  runtime: IAgentRuntime,
): void {
  buses.delete(runtime);
}

// ---------------------------------------------------------------------------
// Re-exports so callers import bus + family types from one place.
// ---------------------------------------------------------------------------

export type { LifeOpsBusFamily, LifeOpsTelemetryFamily };
