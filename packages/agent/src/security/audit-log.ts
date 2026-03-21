/**
 * Append-only audit log for sandbox security events.
 * Never log real secret values — only token IDs and metadata.
 */

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

export interface AuditLogConfig {
  console?: boolean;
  maxEntries?: number;
  sink?: (entry: AuditEntry) => void;
}

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

/** @internal Test-only helper to isolate process-wide audit state between specs. */
export function __resetAuditFeedForTests(): void {
  processFeedEntries.length = 0;
  processFeedSubscribers.clear();
}

export class SandboxAuditLog {
  private entries: AuditEntry[] = [];
  private consoleEnabled: boolean;
  private maxEntries: number;
  private sink?: (entry: AuditEntry) => void;

  constructor(config: AuditLogConfig = {}) {
    this.consoleEnabled = config.console ?? true;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.sink = config.sink;
  }

  record(entry: Omit<AuditEntry, "timestamp">): void {
    const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
    this.entries.push(full);
    publishToProcessFeed(full);

    trimEntries(this.entries, this.maxEntries);

    if (this.consoleEnabled) {
      const line = `[AUDIT:${full.severity.toUpperCase()}] ${full.type}: ${full.summary}`;
      if (full.severity === "critical" || full.severity === "error")
        console.error(line);
      else if (full.severity === "warn") console.warn(line);
      else console.log(line);
    }

    this.sink?.(full);
  }

  recordTokenReplacement(
    direction: "outbound" | "inbound",
    url: string,
    tokenIds: string[],
  ): void {
    this.record({
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
  ): void {
    this.record({
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
  ): void {
    this.record({
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
