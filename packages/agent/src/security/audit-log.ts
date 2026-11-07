/**
 * Append-only audit log for sandbox security events. The in-memory feed is a
 * bounded operational view; durability comes from attached sinks, and a
 * required sink's failure rejects the record. Never log real secret values —
 * only token IDs and metadata.
 */

import {
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  logger,
  ROLE_WRITE_AUDIT_LOG_TYPE,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

export const AUDIT_EVENT_TYPES = [
  "sandbox_mode_transition",
  "secret_token_replacement_outbound",
  "secret_sanitization_inbound",
  "privileged_capability_invocation",
  "policy_decision",
  "signing_request_submitted",
  "signing_request_rejected",
  "signing_request_approved",
  "plugin_fallback_attempt",
  "security_kill_switch",
  "sandbox_lifecycle",
  "fetch_proxy_error",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
export const AUDIT_SEVERITIES = ["info", "warn", "error", "critical"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

const DEFAULT_MAX_ENTRIES = 5000;
const PROCESS_FEED_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;

const processFeedEntries: AuditEntry[] = [];
const processFeedSubscribers = new Set<AuditFeedSubscriber>();

export interface AuditEntry {
  timestamp: string;
  type: AuditEventType;
  summary: string;
  metadata?: Record<string, string | number | boolean | null>;
  severity: AuditSeverity;
  traceId?: string;
}

/**
 * Destination for audit entries. Durable sinks commit an entry to persistent
 * storage before `append` resolves. A required sink's failure rejects the
 * record; optional sink failures are reported through the structured logger.
 */
export interface AuditSink {
  readonly name: string;
  readonly durable: boolean;
  readonly required: boolean;
  append(entry: AuditEntry): Promise<void>;
}

export interface AuditLogConfig {
  console?: boolean;
  maxEntries?: number;
  /** Synchronous observer, delivered as an optional non-durable sink. */
  sink?: (entry: AuditEntry) => void;
  sinks?: readonly AuditSink[];
  /**
   * Hold entries in an ordered outbox until a durable sink is attached, so no
   * entry is acknowledged before it is persisted.
   */
  requireDurableSink?: boolean;
}

/** `logs.type` for sandbox audit entries committed by the runtime-log sink. */
export const SANDBOX_AUDIT_LOG_TYPE = "sandbox_audit";
/** `logs.type` for confidential-inference dispatch audit records. */
export const CONFIDENTIAL_INFERENCE_AUDIT_LOG_TYPE = "confidential_inference";
/** Durable audit log types that lifecycle retention must never delete. */
export const DURABLE_AUDIT_LOG_TYPES: ReadonlySet<string> = new Set([
  ROLE_WRITE_AUDIT_LOG_TYPE,
  SANDBOX_AUDIT_LOG_TYPE,
  CONFIDENTIAL_INFERENCE_AUDIT_LOG_TYPE,
]);

export interface AuditFeedQuery {
  type?: AuditEventType;
  severity?: AuditSeverity;
  sinceMs?: number;
  limit?: number;
}

export type AuditFeedSubscriber = (entry: AuditEntry) => void;

function trimEntries(entries: AuditEntry[], maxEntries: number): void {
  if (entries.length <= maxEntries) return;
  const keep = Math.floor(maxEntries / 2);
  if (keep <= 0) {
    entries.length = 0;
    return;
  }
  entries.splice(0, entries.length - keep);
}

function publishToProcessFeed(entry: AuditEntry): void {
  processFeedEntries.push(entry);
  trimEntries(processFeedEntries, PROCESS_FEED_MAX_ENTRIES);
  for (const subscriber of processFeedSubscribers) {
    try {
      subscriber(entry);
    } catch {
      // Ignore subscriber failures so audit recording is never blocked.
    }
  }
}

function toSinceTimestamp(sinceMs: number | undefined): number | undefined {
  if (sinceMs === undefined) return undefined;
  if (!Number.isFinite(sinceMs)) return undefined;
  return Math.trunc(sinceMs);
}

function toBoundedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit)) return undefined;
  return Math.max(1, Math.trunc(limit));
}

export function queryAuditFeed(query: AuditFeedQuery = {}): AuditEntry[] {
  const sinceTimestamp = toSinceTimestamp(query.sinceMs);
  const boundedLimit = toBoundedLimit(query.limit);
  let entries = processFeedEntries;

  if (query.type) {
    entries = entries.filter((entry) => entry.type === query.type);
  }
  if (query.severity) {
    entries = entries.filter((entry) => entry.severity === query.severity);
  }
  if (sinceTimestamp !== undefined) {
    entries = entries.filter(
      (entry) => Date.parse(entry.timestamp) >= sinceTimestamp,
    );
  }
  if (boundedLimit !== undefined) {
    return entries.slice(-boundedLimit);
  }
  return [...entries];
}

export function getAuditFeedSize(): number {
  return processFeedEntries.length;
}

export function subscribeAuditFeed(
  subscriber: AuditFeedSubscriber,
): () => void {
  processFeedSubscribers.add(subscriber);
  return () => {
    processFeedSubscribers.delete(subscriber);
  };
}

type PendingAudit = {
  entry: AuditEntry;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function sinkFailure(
  failures: ReadonlyArray<{ sink: string; error: unknown }>,
) {
  return new ElizaError("Audit delivery requirements were not met", {
    code: "AUDIT_SINK_FAILED",
    cause: new AggregateError(failures.map((failure) => failure.error)),
    context: { sinks: failures.map((failure) => failure.sink) },
  });
}

export class SandboxAuditLog {
  private entries: AuditEntry[] = [];
  private consoleEnabled: boolean;
  private maxEntries: number;
  private readonly sinks: AuditSink[] = [];
  private readonly requireDurableSink: boolean;
  private readonly outbox: PendingAudit[] = [];
  private delivery: Promise<void> = Promise.resolve();

  constructor(config: AuditLogConfig = {}) {
    this.consoleEnabled = config.console ?? true;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.requireDurableSink = config.requireDurableSink === true;
    const observer = config.sink;
    if (observer) {
      this.sinks.push({
        name: "observer",
        durable: false,
        required: false,
        async append(entry) {
          observer(entry);
        },
      });
    }
    this.sinks.push(...(config.sinks ?? []));
  }

  /** True when an attached sink persists entries durably. */
  get hasDurableSink(): boolean {
    return this.sinks.some((sink) => sink.durable);
  }

  /** Entries recorded but not yet delivered because no durable sink exists. */
  get pendingCount(): number {
    return this.outbox.length;
  }

  /**
   * Attach a sink. Attaching a durable sink drains the outbox in record order;
   * each held record settles with its own delivery outcome.
   */
  async addSink(sink: AuditSink): Promise<void> {
    this.sinks.push(sink);
    if (!sink.durable) return;
    const pending = this.outbox.splice(0);
    const outcomes = await Promise.allSettled(
      pending.map(async ({ entry, resolve, reject }) => {
        try {
          await this.deliver(entry);
          resolve();
        } catch (error) {
          // error-policy:J2 settle the held record and fail sink attachment too.
          reject(error);
          throw error;
        }
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      throw new ElizaError("Audit outbox could not be durably drained", {
        code: "AUDIT_SINK_FAILED",
        cause: new AggregateError(failures),
        context: { failedEntries: failures.length },
      });
    }
  }

  /**
   * Record one entry. Resolves after delivery meets required sink and durability
   * guarantees; rejects with `AUDIT_SINK_FAILED` when either requirement fails.
   */
  record(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
    this.entries.push(full);
    publishToProcessFeed(full);

    trimEntries(this.entries, this.maxEntries);

    if (this.consoleEnabled) {
      const line = `[SandboxAuditLog] [AUDIT:${full.severity.toUpperCase()}] ${full.type}: ${full.summary}`;
      if (full.severity === "critical" || full.severity === "error") {
        logger.error(line);
      } else if (full.severity === "warn") {
        logger.warn(line);
      } else {
        logger.info(line);
      }
    }

    if (this.requireDurableSink && !this.hasDurableSink) {
      return new Promise<void>((resolve, reject) => {
        this.outbox.push({ entry: full, resolve, reject });
      });
    }
    return this.deliver(full);
  }

  /** Deliver in record order; one entry's failure never blocks the next. */
  private deliver(entry: AuditEntry): Promise<void> {
    const delivered = this.delivery.then(() => this.fanOut(entry));
    this.delivery = delivered.then(
      () => undefined,
      () => undefined,
    );
    return delivered;
  }

  private async fanOut(entry: AuditEntry): Promise<void> {
    const failures: Array<{ sink: string; error: unknown }> = [];
    const durableFailures: Array<{ sink: string; error: unknown }> = [];
    let durablyCommitted = false;
    for (const sink of [...this.sinks]) {
      try {
        await sink.append(entry);
        if (sink.durable) durablyCommitted = true;
      } catch (error) {
        // error-policy:J2 Required failures reject below; optional ones stay visible.
        logger.error(
          {
            sink: sink.name,
            required: sink.required,
            type: entry.type,
            error: error instanceof Error ? error.message : String(error),
          },
          "[SandboxAuditLog] audit sink delivery failed",
        );
        const failure = { sink: sink.name, error };
        if (sink.required) failures.push(failure);
        else if (sink.durable) durableFailures.push(failure);
      }
    }
    if (this.requireDurableSink && !durablyCommitted) {
      failures.push(...durableFailures);
    }
    if (failures.length > 0) throw sinkFailure(failures);
  }

  recordTokenReplacement(
    direction: "outbound" | "inbound",
    url: string,
    tokenIds: string[],
  ): Promise<void> {
    return this.record({
      type:
        direction === "outbound"
          ? "secret_token_replacement_outbound"
          : "secret_sanitization_inbound",
      summary: `${direction}: ${tokenIds.length} token(s) for ${url}`,
      metadata: {
        direction,
        url,
        tokenCount: tokenIds.length,
        tokenIds: tokenIds.join(","),
      },
      severity: "info",
    });
  }

  recordCapabilityInvocation(
    capability: string,
    detail: string,
    metadata?: Record<string, string | number | boolean>,
  ): Promise<void> {
    return this.record({
      type: "privileged_capability_invocation",
      summary: `${capability}: ${detail}`,
      metadata: { capability, ...metadata },
      severity: "info",
    });
  }

  recordPolicyDecision(
    decision: "allow" | "deny",
    reason: string,
    metadata?: Record<string, string | number | boolean>,
  ): Promise<void> {
    return this.record({
      type: "policy_decision",
      summary: `${decision}: ${reason}`,
      metadata: { decision, reason, ...metadata },
      severity: decision === "deny" ? "warn" : "info",
    });
  }

  getRecent(count = 100): AuditEntry[] {
    return this.entries.slice(-count);
  }

  getByType(type: AuditEventType, count = 50): AuditEntry[] {
    return this.entries.filter((e) => e.type === type).slice(-count);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

/**
 * Report a record whose caller cannot await it (synchronous API or event
 * callback). The failure stays visible through the structured logger.
 */
export function reportDetachedAuditRecord(record: Promise<void>): void {
  record.catch((error: unknown) => {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "[SandboxAuditLog] audit record was not durably accepted",
    );
  });
}

/**
 * Required durable sink that commits each entry to the runtime database logs
 * under {@link SANDBOX_AUDIT_LOG_TYPE}, in an agent-owned audit room. These
 * rows survive restart and are excluded from lifecycle log retention; they are
 * not an independent tamper-evident ledger.
 */
export async function createRuntimeLogAuditSink(
  runtime: IAgentRuntime,
): Promise<AuditSink> {
  const roomId = stringToUuid(`${runtime.agentId}:sandbox-audit-room`) as UUID;
  if ((await runtime.getRoomsByIds([roomId]))?.length !== 1) {
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        type: ChannelType.SELF,
        source: "sandbox-audit",
      },
    ]);
  }
  return Object.freeze({
    name: "runtime-logs",
    durable: true,
    required: true,
    async append(entry: AuditEntry): Promise<void> {
      await runtime.log({
        entityId: runtime.agentId,
        roomId,
        type: SANDBOX_AUDIT_LOG_TYPE,
        body: {
          source: "sandbox-audit",
          metadata: {
            timestamp: entry.timestamp,
            type: entry.type,
            summary: entry.summary,
            severity: entry.severity,
            ...(entry.traceId === undefined ? {} : { traceId: entry.traceId }),
            ...(entry.metadata === undefined ? {} : { fields: entry.metadata }),
          },
        },
      });
    },
  } satisfies AuditSink);
}
