/**
 * Integration reliability read-model for the admin operations dashboard.
 * Aggregates provider integration telemetry (capability calls, OAuth and
 * webhook errors, policy denials, reauth demands, sync completions, and
 * kill-switch blocks) into per-provider health, cost, and latency reports
 * with SLO alerting, and exposes the production account setup runbook.
 *
 * Every event is validated and secret/PII-redacted on ingest, and the
 * finished dashboard payload can be audited with
 * {@link findSecretLeaksInPayload} — nothing token-, key-, or email-shaped
 * may survive into a browser payload. Kill switches and release evidence
 * arrive as operator-managed JSON config (worker env bindings); malformed
 * entries are surfaced as explicit invalid results, never silently dropped.
 */

/** Telemetry event kinds the dashboard aggregates. Append-only. */
export const INTEGRATION_TELEMETRY_KINDS = [
  "capability_call",
  "oauth_error",
  "webhook_error",
  "policy_deny",
  "reauth_required",
  "sync_completed",
  "kill_switch_block",
] as const;

export type IntegrationTelemetryKind = (typeof INTEGRATION_TELEMETRY_KINDS)[number];

/** Outcome of the underlying provider interaction. */
export const INTEGRATION_TELEMETRY_OUTCOMES = ["success", "failure"] as const;
export type IntegrationTelemetryOutcome = (typeof INTEGRATION_TELEMETRY_OUTCOMES)[number];

/** A single validated, redacted telemetry event. */
export interface IntegrationTelemetryEvent {
  /** Producer-supplied idempotency key; duplicate ids are ignored on record. */
  id: string;
  /** Provider slug, e.g. "google-maps", "plaid". */
  provider: string;
  /** Optional capability id within the provider, e.g. "maps.search". */
  capability: string | null;
  kind: IntegrationTelemetryKind;
  outcome: IntegrationTelemetryOutcome;
  /** Machine-readable error/denial code; redacted free text is not a code. */
  code: string | null;
  /** End-to-end latency of the provider interaction, when measured. */
  latencyMs: number | null;
  /** Metered cost in micro-USD (1e-6 USD), when metered. */
  costMicros: number | null;
  /** ISO-8601 occurrence time. */
  occurredAt: string;
  /** Short redacted operator-facing detail. Never raw provider payloads. */
  detail: string | null;
}

/** Thrown when telemetry input fails validation. */
export class IntegrationTelemetryValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IntegrationTelemetryValidationError";
    this.code = code;
  }
}

const MAX_STRING_LENGTH = 512;
const PROVIDER_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Secret/PII detection patterns applied to every free-text field on ingest
 * and used by {@link findSecretLeaksInPayload} for the redaction audit.
 * Ordered so structured credential shapes match before generic entropy.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
  /\b(?:api[-_]?key|token|secret|password|client[-_]?secret)\s*[=:]\s*[^\s"'&]{4,}/gi,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b[a-f0-9]{32,}\b/gi,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

const REDACTION_TOKEN = "[redacted]";

/** Replace any secret- or PII-shaped substring with `[redacted]`. */
export function redactIntegrationDiagnostics(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTION_TOKEN);
  }
  return out.length > MAX_STRING_LENGTH ? `${out.slice(0, MAX_STRING_LENGTH)}…` : out;
}

/**
 * Redaction audit: scan a JSON-serializable payload for secret-shaped
 * strings. Returns the offending matches (empty means the payload is clean).
 * Redaction markers themselves are not leaks.
 */
export function findSecretLeaksInPayload(payload: unknown): string[] {
  const serialized = JSON.stringify(payload) ?? "";
  const leaks: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const matches = serialized.match(pattern);
    if (matches) {
      for (const match of matches) {
        if (!match.includes(REDACTION_TOKEN)) {
          leaks.push(match);
        }
      }
    }
  }
  return leaks;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new IntegrationTelemetryValidationError(
      "invalid_field",
      `${field} must be a non-empty string`,
    );
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new IntegrationTelemetryValidationError(
      "field_too_long",
      `${field} exceeds ${MAX_STRING_LENGTH} characters`,
    );
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new IntegrationTelemetryValidationError(
      "invalid_field",
      `${field} must be a non-negative finite number`,
    );
  }
  return value;
}

/**
 * Validate untrusted telemetry input into a redacted
 * {@link IntegrationTelemetryEvent}. Throws
 * {@link IntegrationTelemetryValidationError} on any malformed field —
 * an explicit invalid result, never a fake-valid default.
 */
export function parseIntegrationTelemetryEvent(input: unknown): IntegrationTelemetryEvent {
  if (typeof input !== "object" || input === null) {
    throw new IntegrationTelemetryValidationError(
      "invalid_event",
      "telemetry event must be an object",
    );
  }
  const raw = input as Record<string, unknown>;
  const id = requireString(raw.id, "id");
  const provider = requireString(raw.provider, "provider");
  if (!PROVIDER_SLUG_PATTERN.test(provider)) {
    throw new IntegrationTelemetryValidationError(
      "invalid_provider",
      "provider must be a lowercase slug",
    );
  }
  const kind = requireString(raw.kind, "kind") as IntegrationTelemetryKind;
  if (!INTEGRATION_TELEMETRY_KINDS.includes(kind)) {
    throw new IntegrationTelemetryValidationError(
      "invalid_kind",
      `kind must be one of: ${INTEGRATION_TELEMETRY_KINDS.join(", ")}`,
    );
  }
  const outcome = requireString(raw.outcome, "outcome") as IntegrationTelemetryOutcome;
  if (!INTEGRATION_TELEMETRY_OUTCOMES.includes(outcome)) {
    throw new IntegrationTelemetryValidationError(
      "invalid_outcome",
      'outcome must be "success" or "failure"',
    );
  }
  const occurredAt = requireString(raw.occurredAt, "occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new IntegrationTelemetryValidationError(
      "invalid_occurred_at",
      "occurredAt must be an ISO-8601 timestamp",
    );
  }
  const capability =
    raw.capability === undefined || raw.capability === null
      ? null
      : requireString(raw.capability, "capability");
  const code =
    raw.code === undefined || raw.code === null
      ? null
      : redactIntegrationDiagnostics(requireString(raw.code, "code"));
  const detail =
    raw.detail === undefined || raw.detail === null
      ? null
      : redactIntegrationDiagnostics(requireString(raw.detail, "detail"));
  return {
    id,
    provider,
    capability,
    kind,
    outcome,
    code,
    latencyMs: optionalNumber(raw.latencyMs, "latencyMs"),
    costMicros: optionalNumber(raw.costMicros, "costMicros"),
    occurredAt: new Date(occurredAt).toISOString(),
    detail,
  };
}

/**
 * Bounded in-memory telemetry buffer. `record` is idempotent per event id,
 * so duplicate webhook deliveries and producer retries do not double-count.
 * Oldest events are evicted once `capacity` is exceeded.
 */
export class IntegrationTelemetryRecorder {
  private readonly capacity: number;
  private readonly events = new Map<string, IntegrationTelemetryEvent>();

  constructor(options: { capacity?: number } = {}) {
    const capacity = options.capacity ?? 5000;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new IntegrationTelemetryValidationError(
        "invalid_capacity",
        "capacity must be a positive integer",
      );
    }
    this.capacity = capacity;
  }

  /** Validate, redact, and store one event. Returns whether it was new. */
  record(input: unknown): {
    event: IntegrationTelemetryEvent;
    recorded: boolean;
  } {
    const event = parseIntegrationTelemetryEvent(input);
    if (this.events.has(event.id)) {
      return { event: this.events.get(event.id) as IntegrationTelemetryEvent, recorded: false };
    }
    this.events.set(event.id, event);
    while (this.events.size > this.capacity) {
      const oldest = this.events.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.events.delete(oldest);
    }
    return { event, recorded: true };
  }

  snapshot(): IntegrationTelemetryEvent[] {
    return [...this.events.values()];
  }

  get size(): number {
    return this.events.size;
  }

  clear(): void {
    this.events.clear();
  }
}

/** Process-wide recorder the cloud worker records into and reads from. */
export const integrationTelemetryRecorder = new IntegrationTelemetryRecorder();

/** Operator-declared kill switch disabling a provider or one capability. */
export interface IntegrationKillSwitch {
  provider: string;
  /** Null disables the whole provider. */
  capability: string | null;
  reason: string;
  actor: string | null;
  activatedAt: string | null;
}

/** Result of parsing operator kill-switch config: valid + explicit rejects. */
export interface IntegrationKillSwitchParseResult {
  switches: IntegrationKillSwitch[];
  invalid: string[];
}

/**
 * Parse the operator kill-switch JSON config (worker env binding
 * `INTEGRATION_KILL_SWITCHES`). Malformed entries land in `invalid` with a
 * reason; they are never silently coerced into an active or inactive switch.
 */
export function parseIntegrationKillSwitches(
  raw: string | undefined | null,
): IntegrationKillSwitchParseResult {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { switches: [], invalid: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted-input sanitizing: malformed operator JSON is
    // reported as an explicit invalid entry, never treated as "no switches
    // configured" silently.
    return { switches: [], invalid: ["config_not_json"] };
  }
  if (!Array.isArray(parsed)) {
    return { switches: [], invalid: ["config_not_array"] };
  }
  const switches: IntegrationKillSwitch[] = [];
  const invalid: string[] = [];
  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      invalid.push(`entry_${index}_not_object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.provider !== "string" || !PROVIDER_SLUG_PATTERN.test(record.provider)) {
      invalid.push(`entry_${index}_invalid_provider`);
      return;
    }
    if (typeof record.reason !== "string" || record.reason.length === 0) {
      invalid.push(`entry_${index}_missing_reason`);
      return;
    }
    switches.push({
      provider: record.provider,
      capability:
        typeof record.capability === "string" && record.capability.length > 0
          ? record.capability
          : null,
      reason: redactIntegrationDiagnostics(record.reason),
      actor: typeof record.actor === "string" ? record.actor : null,
      activatedAt:
        typeof record.activatedAt === "string" && !Number.isNaN(Date.parse(record.activatedAt))
          ? new Date(record.activatedAt).toISOString()
          : null,
    });
  });
  return { switches, invalid };
}

/** Release-evidence review states for a provider integration. */
export const INTEGRATION_EVIDENCE_STATUSES = ["verified", "pending", "missing"] as const;
export type IntegrationEvidenceStatus = (typeof INTEGRATION_EVIDENCE_STATUSES)[number];

/** Recorded release-evidence state (sandbox/real-account proof) per provider. */
export interface IntegrationReleaseEvidence {
  provider: string;
  status: IntegrationEvidenceStatus;
  /** Issue/PR reference holding the evidence matrix, never a secret. */
  reference: string | null;
  verifiedAt: string | null;
}

/** Parse operator release-evidence JSON config with explicit invalids. */
export function parseIntegrationReleaseEvidence(raw: string | undefined | null): {
  evidence: IntegrationReleaseEvidence[];
  invalid: string[];
} {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { evidence: [], invalid: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted-input sanitizing: malformed evidence config is
    // an explicit invalid result, not an empty-and-healthy evidence list.
    return { evidence: [], invalid: ["config_not_json"] };
  }
  if (!Array.isArray(parsed)) {
    return { evidence: [], invalid: ["config_not_array"] };
  }
  const evidence: IntegrationReleaseEvidence[] = [];
  const invalid: string[] = [];
  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      invalid.push(`entry_${index}_not_object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.provider !== "string" || !PROVIDER_SLUG_PATTERN.test(record.provider)) {
      invalid.push(`entry_${index}_invalid_provider`);
      return;
    }
    if (
      typeof record.status !== "string" ||
      !INTEGRATION_EVIDENCE_STATUSES.includes(record.status as IntegrationEvidenceStatus)
    ) {
      invalid.push(`entry_${index}_invalid_status`);
      return;
    }
    evidence.push({
      provider: record.provider,
      status: record.status as IntegrationEvidenceStatus,
      reference:
        typeof record.reference === "string"
          ? redactIntegrationDiagnostics(record.reference)
          : null,
      verifiedAt:
        typeof record.verifiedAt === "string" && !Number.isNaN(Date.parse(record.verifiedAt))
          ? new Date(record.verifiedAt).toISOString()
          : null,
    });
  });
  return { evidence, invalid };
}

/** Service-level objectives the dashboard evaluates providers against. */
export interface IntegrationSloConfig {
  /** Error rate at or above which a provider is "down". */
  maxErrorRate: number;
  /** Error rate at or above which a provider is "degraded". */
  degradedErrorRate: number;
  /** p95 latency above which a provider is "degraded". */
  maxP95LatencyMs: number;
  /** A provider with syncs is "stale" when the last one is older than this. */
  staleSyncAfterMs: number;
}

export const DEFAULT_INTEGRATION_SLO: IntegrationSloConfig = {
  maxErrorRate: 0.25,
  degradedErrorRate: 0.05,
  maxP95LatencyMs: 5000,
  staleSyncAfterMs: 6 * 60 * 60 * 1000,
};

/** Health verdict for one provider. */
export const INTEGRATION_HEALTH_STATUSES = [
  "healthy",
  "degraded",
  "down",
  "disabled",
  "unknown",
] as const;
export type IntegrationHealthStatus = (typeof INTEGRATION_HEALTH_STATUSES)[number];

/** SLO-breach alert emitted alongside the dashboard. */
export interface IntegrationAlert {
  provider: string;
  code:
    | "error_rate_down"
    | "error_rate_degraded"
    | "latency_p95_breach"
    | "stale_sync"
    | "kill_switch_active"
    | "evidence_missing";
  message: string;
}

/** Aggregated per-provider report. */
export interface IntegrationProviderReport {
  provider: string;
  health: IntegrationHealthStatus;
  totals: {
    events: number;
    failures: number;
    errorRate: number;
  };
  latency: {
    p50Ms: number | null;
    p95Ms: number | null;
    samples: number;
  };
  costMicros: number;
  counts: {
    oauthErrors: number;
    webhookErrors: number;
    policyDenies: number;
    reauthRequired: number;
    killSwitchBlocks: number;
  };
  lastSyncAt: string | null;
  syncStale: boolean;
  killSwitches: IntegrationKillSwitch[];
  evidence: IntegrationReleaseEvidence | null;
}

/** The complete dashboard payload served to the admin UI. */
export interface IntegrationReliabilityDashboard {
  generatedAt: string;
  slo: IntegrationSloConfig;
  providers: IntegrationProviderReport[];
  alerts: IntegrationAlert[];
}

/** Nearest-rank percentile over an unsorted sample set. */
function percentile(sortedSamples: number[], p: number): number | null {
  if (sortedSamples.length === 0) {
    return null;
  }
  const rank = Math.ceil((p / 100) * sortedSamples.length);
  return sortedSamples[Math.min(sortedSamples.length, Math.max(1, rank)) - 1];
}

/**
 * Build the reliability dashboard from validated events plus operator
 * kill-switch/evidence config. Pure and deterministic given `now`.
 */
export function buildIntegrationReliabilityDashboard(options: {
  events: IntegrationTelemetryEvent[];
  killSwitches?: IntegrationKillSwitch[];
  evidence?: IntegrationReleaseEvidence[];
  slo?: IntegrationSloConfig;
  now?: Date;
}): IntegrationReliabilityDashboard {
  const slo = options.slo ?? DEFAULT_INTEGRATION_SLO;
  const now = options.now ?? new Date();
  const killSwitches = options.killSwitches ?? [];
  const evidence = options.evidence ?? [];

  const providerNames = new Set<string>();
  for (const event of options.events) {
    providerNames.add(event.provider);
  }
  for (const ks of killSwitches) {
    providerNames.add(ks.provider);
  }
  for (const ev of evidence) {
    providerNames.add(ev.provider);
  }

  const providers: IntegrationProviderReport[] = [];
  const alerts: IntegrationAlert[] = [];

  for (const provider of [...providerNames].sort()) {
    const events = options.events.filter((e) => e.provider === provider);
    const failures = events.filter((e) => e.outcome === "failure").length;
    const errorRate = events.length > 0 ? failures / events.length : 0;
    const latencies = events
      .map((e) => e.latencyMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const p50Ms = percentile(latencies, 50);
    const p95Ms = percentile(latencies, 95);
    const costMicros = events.reduce((sum, e) => sum + (e.costMicros ?? 0), 0);
    const countKind = (kind: IntegrationTelemetryKind): number =>
      events.filter((e) => e.kind === kind).length;
    const syncEvents = events
      .filter((e) => e.kind === "sync_completed" && e.outcome === "success")
      .map((e) => Date.parse(e.occurredAt))
      .sort((a, b) => b - a);
    const lastSyncMs = syncEvents.length > 0 ? syncEvents[0] : null;
    const hasSyncSurface = events.some((e) => e.kind === "sync_completed");
    const syncStale =
      hasSyncSurface && (lastSyncMs === null || now.getTime() - lastSyncMs > slo.staleSyncAfterMs);
    const providerKillSwitches = killSwitches.filter((ks) => ks.provider === provider);
    const providerEvidence = evidence.find((ev) => ev.provider === provider) ?? null;
    const fullyDisabled = providerKillSwitches.some((ks) => ks.capability === null);

    let health: IntegrationHealthStatus;
    if (fullyDisabled) {
      health = "disabled";
    } else if (events.length === 0) {
      health = "unknown";
    } else if (errorRate >= slo.maxErrorRate) {
      health = "down";
    } else if (
      errorRate >= slo.degradedErrorRate ||
      (p95Ms !== null && p95Ms > slo.maxP95LatencyMs) ||
      syncStale
    ) {
      health = "degraded";
    } else {
      health = "healthy";
    }

    if (health === "down") {
      alerts.push({
        provider,
        code: "error_rate_down",
        message: `error rate ${(errorRate * 100).toFixed(1)}% ≥ ${(slo.maxErrorRate * 100).toFixed(1)}% SLO`,
      });
    } else if (events.length > 0 && errorRate >= slo.degradedErrorRate) {
      alerts.push({
        provider,
        code: "error_rate_degraded",
        message: `error rate ${(errorRate * 100).toFixed(1)}% ≥ ${(slo.degradedErrorRate * 100).toFixed(1)}% degraded threshold`,
      });
    }
    if (p95Ms !== null && p95Ms > slo.maxP95LatencyMs) {
      alerts.push({
        provider,
        code: "latency_p95_breach",
        message: `p95 latency ${p95Ms}ms > ${slo.maxP95LatencyMs}ms SLO`,
      });
    }
    if (syncStale) {
      alerts.push({
        provider,
        code: "stale_sync",
        message:
          lastSyncMs === null
            ? "no successful sync recorded"
            : `last successful sync at ${new Date(lastSyncMs).toISOString()}`,
      });
    }
    if (providerKillSwitches.length > 0) {
      alerts.push({
        provider,
        code: "kill_switch_active",
        message: providerKillSwitches
          .map((ks) =>
            ks.capability === null
              ? `provider disabled: ${ks.reason}`
              : `${ks.capability} disabled: ${ks.reason}`,
          )
          .join("; "),
      });
    }
    if (!providerEvidence || providerEvidence.status === "missing") {
      alerts.push({
        provider,
        code: "evidence_missing",
        message: "no verified sandbox/real-account release evidence on file",
      });
    }

    providers.push({
      provider,
      health,
      totals: { events: events.length, failures, errorRate },
      latency: { p50Ms, p95Ms, samples: latencies.length },
      costMicros,
      counts: {
        oauthErrors: countKind("oauth_error"),
        webhookErrors: countKind("webhook_error"),
        policyDenies: countKind("policy_deny"),
        reauthRequired: countKind("reauth_required"),
        killSwitchBlocks: countKind("kill_switch_block"),
      },
      lastSyncAt: lastSyncMs === null ? null : new Date(lastSyncMs).toISOString(),
      syncStale,
      killSwitches: providerKillSwitches,
      evidence: providerEvidence,
    });
  }

  return {
    generatedAt: now.toISOString(),
    slo,
    providers,
    alerts,
  };
}

/** One production-readiness runbook checklist item. */
export interface IntegrationRunbookItem {
  id: string;
  title: string;
  description: string;
}

/**
 * Production account setup / release runbook checklist for enabling a
 * managed provider integration. Served with the dashboard so operators
 * review it next to live health, and mirrored in
 * `packages/cloud/docs/integration-production-runbook.md`.
 */
export const PRODUCTION_INTEGRATION_RUNBOOK: readonly IntegrationRunbookItem[] = [
  {
    id: "provider-account",
    title: "Production provider account provisioned",
    description:
      "Dedicated production app/account created with billing enabled; credentials stored only in Cloud secret custody, never in source, fixtures, or logs.",
  },
  {
    id: "oauth-configuration",
    title: "OAuth client and redirect URIs verified",
    description:
      "Production OAuth client configured with exact redirect URIs, minimal scopes, and verified consent screen; refresh and revoke paths exercised.",
  },
  {
    id: "webhook-registration",
    title: "Webhooks registered and signature-verified",
    description:
      "Provider webhooks point at the production endpoint, signature verification is enforced, and duplicate-delivery idempotency is proven.",
  },
  {
    id: "quota-and-cost",
    title: "Quotas, rate limits, and cost alerts configured",
    description:
      "Provider-side quotas and Cloud-side metering are set with cost alert thresholds; the dashboard cost column reconciles with provider billing.",
  },
  {
    id: "slo-baseline",
    title: "SLO baseline captured",
    description:
      "Error-rate and p95 latency baselines recorded under production traffic and the dashboard SLO thresholds reviewed against them.",
  },
  {
    id: "kill-switch-drill",
    title: "Kill-switch drill completed",
    description:
      "Provider and per-capability kill switches toggled in staging; user-facing degrade verified as an explicit unavailable state.",
  },
  {
    id: "redaction-audit",
    title: "Redaction audit passed",
    description:
      "Telemetry, receipts, logs, and dashboard payloads audited to confirm no token, key, cookie, email, or other PII/secret appears.",
  },
  {
    id: "release-evidence",
    title: "Sandbox/real-account evidence recorded",
    description:
      "The release evidence matrix (sandbox or real-account exercise per CONTRIBUTING.md) is linked from the provider's evidence entry.",
  },
];
