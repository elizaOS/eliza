/**
 * Process-local, bounded security metrics. This module intentionally has no I/O:
 * metrics can never participate in an authority decision or make it fail.
 */
export const GOVERNED_EXECUTION_OUTCOMES = [
  "succeeded",
  "failed",
  "outcome_unknown",
] as const;
export const DENIAL_REASON_CLASSES = [
  "access",
  "policy",
  "authorization",
  "stale_dependency",
  "account_disabled",
  "audit_unavailable",
  "terminal_state",
  "other",
] as const;
export const APPROVAL_DECISIONS = ["approved", "denied"] as const;

export type GovernedExecutionOutcome =
  (typeof GOVERNED_EXECUTION_OUTCOMES)[number];
export type DenialReasonClass = (typeof DENIAL_REASON_CLASSES)[number];
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

const executions = new Map<GovernedExecutionOutcome, number>(
  GOVERNED_EXECUTION_OUTCOMES.map((value) => [value, 0]),
);
const denials = new Map<DenialReasonClass, number>(
  DENIAL_REASON_CLASSES.map((value) => [value, 0]),
);
const approvals = new Map<ApprovalDecision, number>(
  APPROVAL_DECISIONS.map((value) => [value, 0]),
);
let bypassDenials = 0;
let nonceContentions = 0;
let lastCheckpointAtMs: number | null = null;
let failObserverForTests = false;

function incrementBounded<T extends string>(
  map: Map<T, number>,
  value: string,
  allowed: readonly T[],
): void {
  if (!allowed.includes(value as T)) return;
  map.set(value as T, (map.get(value as T) ?? 0) + 1);
}

export function classifyDenialReason(reasonCode: unknown): DenialReasonClass {
  if (typeof reasonCode !== "string") return "other";
  const normalized = reasonCode.toUpperCase();
  if (
    normalized.startsWith("SCOPE_") ||
    normalized.startsWith("ACCESS_") ||
    normalized.startsWith("GRANT_") ||
    normalized.includes("GRANT")
  )
    return "access";
  if (normalized.startsWith("POLICY_")) return "policy";
  if (normalized.includes("STALE_") || normalized.includes("DEPENDENCY"))
    return "stale_dependency";
  if (normalized.includes("ACCOUNT_DISABLED")) return "account_disabled";
  if (normalized.includes("AUDIT_UNAVAILABLE")) return "audit_unavailable";
  if (normalized.includes("TERMINAL_STATE")) return "terminal_state";
  if (normalized.startsWith("EXEC_AUTH_") || normalized.startsWith("AUTH_"))
    return "authorization";
  return "other";
}

export function observeGovernedExecution(outcome: string): void {
  incrementBounded(executions, outcome, GOVERNED_EXECUTION_OUTCOMES);
}
export function observeDenial(reasonCode: unknown): void {
  incrementBounded(
    denials,
    classifyDenialReason(reasonCode),
    DENIAL_REASON_CLASSES,
  );
}
export function observeApprovalDecision(decision: string): void {
  incrementBounded(approvals, decision, APPROVAL_DECISIONS);
}
export function observeBypassDenial(): void {
  bypassDenials += 1;
}
export function observeNonceClaimContention(): void {
  nonceContentions += 1;
}
export function observeAuditCheckpoint(createdAtMs = Date.now()): void {
  lastCheckpointAtMs = createdAtMs;
}

/** Observe only established typed audit events. Unknown actions are ignored. */
export function observeSecurityAuditEvent(
  action: string,
  metadata: unknown = {},
): void {
  if (failObserverForTests)
    throw new Error("injected security metrics observer failure");
  let fields: Record<string, unknown> = {};
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    fields = metadata as Record<string, unknown>;
  } else if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fields = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed metadata is untrusted detail, never a metric label.
    }
  }
  if (action === "provider.execution.succeeded")
    observeGovernedExecution("succeeded");
  else if (action === "provider.execution.failed")
    observeGovernedExecution("failed");
  else if (action === "provider.execution.outcome_unknown")
    observeGovernedExecution("outcome_unknown");
  else if (action === "provider.action.denied") {
    const policyReasons = fields.policyReasonCodes;
    const reason =
      fields.policyEffect === "hard_deny"
        ? "POLICY_HARD_DENY"
        : fields.policyEffect === "not_evaluated"
          ? "ACCESS_DENIED"
          : Array.isArray(policyReasons) && policyReasons.length > 0
            ? policyReasons[0]
            : (fields.reasonCode ?? fields.accessReasonCode);
    observeDenial(reason);
  } else if (action === "provider.execution.denied_at_boundary") {
    observeDenial(fields.reasonCode);
    observeBypassDenial();
  } else if (action === "provider.approval.decided") {
    const decision = fields.decision ?? fields.toStatus;
    observeApprovalDecision(
      decision === "approved"
        ? "approved"
        : decision === "approval_denied"
          ? "denied"
          : "",
    );
  }
}

function metricLine(name: string, labels: string, value: number): string {
  return `${name}${labels.length > 0 ? `{${labels}}` : ""} ${value}`;
}

export function renderSecurityMetrics(nowMs = Date.now()): string {
  const lines = [
    "# HELP steward_governed_executions_total Governed executions completed by bounded outcome.",
    "# TYPE steward_governed_executions_total counter",
  ];
  for (const outcome of GOVERNED_EXECUTION_OUTCOMES) {
    lines.push(
      metricLine(
        "steward_governed_executions_total",
        `outcome="${outcome}"`,
        executions.get(outcome) ?? 0,
      ),
    );
  }
  lines.push(
    "# HELP steward_security_denials_total Security denials by bounded reason class.",
    "# TYPE steward_security_denials_total counter",
  );
  for (const reasonClass of DENIAL_REASON_CLASSES) {
    lines.push(
      metricLine(
        "steward_security_denials_total",
        `reason_class="${reasonClass}"`,
        denials.get(reasonClass) ?? 0,
      ),
    );
  }
  lines.push(
    "# HELP steward_approval_decisions_total Provider approval decisions by bounded decision.",
    "# TYPE steward_approval_decisions_total counter",
  );
  for (const decision of APPROVAL_DECISIONS) {
    lines.push(
      metricLine(
        "steward_approval_decisions_total",
        `decision="${decision}"`,
        approvals.get(decision) ?? 0,
      ),
    );
  }
  lines.push(
    "# HELP steward_governed_boundary_denials_total Governed execution attempts denied at the provider boundary.",
    "# TYPE steward_governed_boundary_denials_total counter",
    metricLine("steward_governed_boundary_denials_total", "", bypassDenials),
    "# HELP steward_nonce_claim_contentions_total Governed execution nonce claims lost to contention.",
    "# TYPE steward_nonce_claim_contentions_total counter",
    metricLine("steward_nonce_claim_contentions_total", "", nonceContentions),
    "# HELP steward_audit_checkpoint_age_seconds Seconds since this process last created an audit checkpoint; -1 means none observed since start.",
    "# TYPE steward_audit_checkpoint_age_seconds gauge",
    metricLine(
      "steward_audit_checkpoint_age_seconds",
      "",
      lastCheckpointAtMs === null
        ? -1
        : Math.max(0, (nowMs - lastCheckpointAtMs) / 1000),
    ),
  );
  return `${lines.join("\n")}\n`;
}

export function securityMetricsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.STEWARD_METRICS_ENABLED === "true";
}

export function metricsTokenIsValid(
  candidate: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const configured = env.STEWARD_METRICS_TOKEN;
  if (!configured || configured.length < 32 || !candidate) return false;
  const expected = new TextEncoder().encode(configured);
  const actual = new TextEncoder().encode(candidate);
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index];
  }
  return difference === 0;
}

export function __setSecurityMetricsObserverFailureForTests(
  enabled: boolean,
): void {
  failObserverForTests = enabled;
}

export function __resetSecurityMetricsForTests(): void {
  for (const key of GOVERNED_EXECUTION_OUTCOMES) executions.set(key, 0);
  for (const key of DENIAL_REASON_CLASSES) denials.set(key, 0);
  for (const key of APPROVAL_DECISIONS) approvals.set(key, 0);
  bypassDenials = 0;
  nonceContentions = 0;
  lastCheckpointAtMs = null;
  failObserverForTests = false;
}
