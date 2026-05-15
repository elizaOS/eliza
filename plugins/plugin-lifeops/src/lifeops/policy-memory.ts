export const LIFEOPS_POLICY_OPERATIONS = [
  "read_aloud",
  "delete",
  "send",
  "spend_money",
  "proofread_apply",
  "store_affect",
  "bulk_cleanup",
] as const;

export type LifeOpsPolicyOperation = (typeof LIFEOPS_POLICY_OPERATIONS)[number];

export const LIFEOPS_POLICY_EFFECTS = [
  "allow",
  "deny",
  "require_approval",
  "prompt_user_first",
] as const;

export type LifeOpsPolicyEffect = (typeof LIFEOPS_POLICY_EFFECTS)[number];

export type LifeOpsPolicyDecisionOutcome =
  | "allow"
  | "deny"
  | "require_approval";

export const LIFEOPS_POLICY_REVIEW_STATES = [
  "draft",
  "active",
  "needs_review",
  "rejected",
  "retired",
] as const;

export type LifeOpsPolicyReviewState =
  (typeof LIFEOPS_POLICY_REVIEW_STATES)[number];

export const LIFEOPS_POLICY_SENSITIVITY_LEVELS = [
  "public",
  "routine",
  "personal",
  "confidential",
  "restricted",
] as const;

export type LifeOpsPolicySensitivity =
  (typeof LIFEOPS_POLICY_SENSITIVITY_LEVELS)[number];

export const LIFEOPS_POLICY_SURFACES = [
  "chat",
  "voice",
  "email",
  "browser",
  "desktop",
  "mobile",
  "automation",
  "api",
] as const;

export type LifeOpsPolicySurface = (typeof LIFEOPS_POLICY_SURFACES)[number];

export const LIFEOPS_POLICY_CHANNELS = [
  "telegram",
  "discord",
  "slack",
  "imessage",
  "sms",
  "signal",
  "whatsapp",
  "x_dm",
  "email",
  "google_calendar",
  "browser",
  "phone",
  "internal",
] as const;

export type LifeOpsPolicyChannel = (typeof LIFEOPS_POLICY_CHANNELS)[number];

export const LIFEOPS_POLICY_SUBJECT_KINDS = [
  "owner",
  "contact",
  "household",
  "agent",
  "organization",
  "automation",
  "any",
] as const;

export type LifeOpsPolicySubjectKind =
  (typeof LIFEOPS_POLICY_SUBJECT_KINDS)[number];

export const LIFEOPS_POLICY_RESOURCE_KINDS = [
  "message",
  "email",
  "calendar_event",
  "file",
  "payment",
  "contact",
  "memory",
  "browser_page",
  "task",
  "unknown",
] as const;

export type LifeOpsPolicyResourceKind =
  (typeof LIFEOPS_POLICY_RESOURCE_KINDS)[number];

export const LIFEOPS_POLICY_EVIDENCE_SOURCES = [
  "user_instruction",
  "user_approval",
  "admin_policy",
  "migration",
  "system_policy",
] as const;

export type LifeOpsPolicyEvidenceSource =
  (typeof LIFEOPS_POLICY_EVIDENCE_SOURCES)[number];

export type LifeOpsPolicyComparisonOperator =
  | "lt"
  | "lte"
  | "eq"
  | "gte"
  | "gt";

export interface LifeOpsPolicyEvidence {
  readonly source: LifeOpsPolicyEvidenceSource;
  readonly sourceId: string;
  readonly recordedAt: string;
  readonly actorId: string;
  readonly reviewId?: string;
}

export interface LifeOpsPolicySubjectSelector {
  readonly kind: LifeOpsPolicySubjectKind;
  readonly ids?: readonly string[];
  readonly labels?: readonly string[];
  readonly sensitivityAtLeast?: LifeOpsPolicySensitivity;
  readonly sensitivityAtMost?: LifeOpsPolicySensitivity;
}

export interface LifeOpsPolicyRequestSubject {
  readonly kind: LifeOpsPolicySubjectKind;
  readonly id: string;
  readonly labels?: readonly string[];
  readonly sensitivity: LifeOpsPolicySensitivity;
}

export interface LifeOpsPolicyResourceRef {
  readonly kind: LifeOpsPolicyResourceKind;
  readonly id: string;
}

export interface LifeOpsPolicyScopeSelector {
  readonly surfaces?: readonly LifeOpsPolicySurface[];
  readonly regions?: readonly string[];
  readonly channels?: readonly LifeOpsPolicyChannel[];
  readonly contactIds?: readonly string[];
  readonly resourceKinds?: readonly LifeOpsPolicyResourceKind[];
  readonly resourceIds?: readonly string[];
}

export interface LifeOpsPolicyRequestScope {
  readonly surface: LifeOpsPolicySurface;
  readonly region?: string;
  readonly channel?: LifeOpsPolicyChannel;
  readonly contactId?: string;
  readonly resource?: LifeOpsPolicyResourceRef;
}

export type LifeOpsPolicyCondition =
  | {
      readonly kind: "amount_usd";
      readonly operator: LifeOpsPolicyComparisonOperator;
      readonly value: number;
    }
  | {
      readonly kind: "bulk_item_count";
      readonly operator: LifeOpsPolicyComparisonOperator;
      readonly value: number;
    }
  | {
      readonly kind: "recipient_count";
      readonly operator: LifeOpsPolicyComparisonOperator;
      readonly value: number;
    }
  | {
      readonly kind: "request_sensitivity_at_least";
      readonly value: LifeOpsPolicySensitivity;
    }
  | {
      readonly kind: "request_sensitivity_at_most";
      readonly value: LifeOpsPolicySensitivity;
    }
  | {
      readonly kind: "contact_sensitivity_at_least";
      readonly value: LifeOpsPolicySensitivity;
    }
  | {
      readonly kind: "contact_sensitivity_at_most";
      readonly value: LifeOpsPolicySensitivity;
    }
  | {
      readonly kind: "currency_is";
      readonly value: string;
    };

export interface LifeOpsPolicyThresholds {
  readonly maxAmountUsd?: number;
  readonly maxBulkItemCount?: number;
  readonly maxRecipientCount?: number;
  readonly maxSensitivity?: LifeOpsPolicySensitivity;
  readonly maxContactSensitivity?: LifeOpsPolicySensitivity;
}

export interface LifeOpsPolicyEffectiveWindow {
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly timezone?: string;
  readonly daysOfWeek?: readonly number[];
  readonly startMinuteOfDay?: number;
  readonly endMinuteOfDay?: number;
}

export interface LifeOpsPolicyRule {
  readonly kind: "lifeops_policy_rule";
  readonly id: string;
  readonly version: 1;
  readonly operations: readonly LifeOpsPolicyOperation[];
  readonly effect: LifeOpsPolicyEffect;
  readonly subject: LifeOpsPolicySubjectSelector;
  readonly scopes?: LifeOpsPolicyScopeSelector;
  readonly conditions?: readonly LifeOpsPolicyCondition[];
  readonly thresholds?: LifeOpsPolicyThresholds;
  readonly precedence: number;
  readonly effectiveWindow?: LifeOpsPolicyEffectiveWindow;
  readonly expiresAt?: string;
  readonly evidence: readonly LifeOpsPolicyEvidence[];
  readonly reviewState: LifeOpsPolicyReviewState;
}

export interface LifeOpsPolicyEvaluationRequest {
  readonly requestId: string;
  readonly operation: LifeOpsPolicyOperation;
  readonly requestedBy: string;
  readonly subject: LifeOpsPolicyRequestSubject;
  readonly scope: LifeOpsPolicyRequestScope;
  readonly sensitivity: LifeOpsPolicySensitivity;
  readonly contactSensitivity?: LifeOpsPolicySensitivity;
  readonly amountUsd?: number;
  readonly currency?: string;
  readonly bulkItemCount?: number;
  readonly recipientCount?: number;
  readonly now?: Date | string | number;
}

export type LifeOpsPolicyDecisionReasonCode =
  | "allowed_by_rule"
  | "denied_by_rule"
  | "approval_required_by_rule"
  | "prompt_user_first"
  | "conflicting_top_rank_rules_resolved_conservatively"
  | "default_requires_approval"
  | "default_denies_high_risk_operation"
  | "malformed_request"
  | "malformed_rule"
  | "duplicate_rule_id";

export interface LifeOpsPolicyDecisionReason {
  readonly code: LifeOpsPolicyDecisionReasonCode;
  readonly ruleIds?: readonly string[];
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export type LifeOpsPolicyIgnoredReasonCode =
  | "operation_mismatch"
  | "review_state_not_active"
  | "expired"
  | "outside_effective_window"
  | "subject_mismatch"
  | "scope_mismatch"
  | "threshold_not_satisfied"
  | "condition_not_satisfied";

export interface LifeOpsPolicyRuleAuditRef {
  readonly ruleId: string;
  readonly effect: LifeOpsPolicyEffect;
  readonly precedence: number;
  readonly specificity: number;
  readonly evidenceIds: readonly string[];
}

export interface LifeOpsPolicyIgnoredRuleRecord {
  readonly ruleId: string;
  readonly reason: LifeOpsPolicyIgnoredReasonCode;
  readonly detail?: string;
}

export interface LifeOpsPolicyInvalidRuleRecord {
  readonly ruleId: string;
  readonly errors: readonly string[];
}

export interface LifeOpsPolicyDecisionRecord {
  readonly decisionId: string;
  readonly evaluatedAt: string;
  readonly requestId: string;
  readonly requestedBy: string;
  readonly operation: LifeOpsPolicyOperation;
  readonly outcome: LifeOpsPolicyDecisionOutcome;
  readonly approvalMode: "approval_queue" | "prompt_user_first" | null;
  readonly reasonCodes: readonly LifeOpsPolicyDecisionReasonCode[];
  readonly selectedRules: readonly LifeOpsPolicyRuleAuditRef[];
  readonly matchedRules: readonly LifeOpsPolicyRuleAuditRef[];
  readonly ignoredRules: readonly LifeOpsPolicyIgnoredRuleRecord[];
  readonly invalidRules: readonly LifeOpsPolicyInvalidRuleRecord[];
}

export interface LifeOpsPolicyDecision {
  readonly requestId: string;
  readonly operation: LifeOpsPolicyOperation;
  readonly outcome: LifeOpsPolicyDecisionOutcome;
  readonly approvalMode: "approval_queue" | "prompt_user_first" | null;
  readonly reasons: readonly LifeOpsPolicyDecisionReason[];
  readonly record: LifeOpsPolicyDecisionRecord;
}

export interface LifeOpsPolicyRuleValidation {
  readonly valid: boolean;
  readonly ruleId: string;
  readonly errors: readonly string[];
}

type RuleMatch =
  | {
      readonly matched: true;
      readonly auditRef: LifeOpsPolicyRuleAuditRef;
      readonly rule: LifeOpsPolicyRule;
    }
  | {
      readonly matched: false;
      readonly ignored: LifeOpsPolicyIgnoredRuleRecord;
    };

const COMPARISON_OPERATORS: readonly LifeOpsPolicyComparisonOperator[] = [
  "lt",
  "lte",
  "eq",
  "gte",
  "gt",
];

const APPROVAL_MODE_BY_EFFECT: Readonly<
  Record<LifeOpsPolicyEffect, "approval_queue" | "prompt_user_first" | null>
> = {
  allow: null,
  deny: null,
  require_approval: "approval_queue",
  prompt_user_first: "prompt_user_first",
};

const OUTCOME_BY_EFFECT: Readonly<
  Record<LifeOpsPolicyEffect, LifeOpsPolicyDecisionOutcome>
> = {
  allow: "allow",
  deny: "deny",
  require_approval: "require_approval",
  prompt_user_first: "require_approval",
};

const EFFECT_SEVERITY: Readonly<Record<LifeOpsPolicyEffect, number>> = {
  allow: 1,
  require_approval: 2,
  prompt_user_first: 2,
  deny: 3,
};

const SENSITIVITY_SCORE: Readonly<Record<LifeOpsPolicySensitivity, number>> = {
  public: 0,
  routine: 1,
  personal: 2,
  confidential: 3,
  restricted: 4,
};

const DEFAULT_OUTCOME_BY_OPERATION: Readonly<
  Record<
    LifeOpsPolicyOperation,
    {
      readonly outcome: LifeOpsPolicyDecisionOutcome;
      readonly reasonCode:
        | "default_requires_approval"
        | "default_denies_high_risk_operation";
    }
  >
> = {
  read_aloud: {
    outcome: "require_approval",
    reasonCode: "default_requires_approval",
  },
  delete: {
    outcome: "deny",
    reasonCode: "default_denies_high_risk_operation",
  },
  send: {
    outcome: "require_approval",
    reasonCode: "default_requires_approval",
  },
  spend_money: {
    outcome: "deny",
    reasonCode: "default_denies_high_risk_operation",
  },
  proofread_apply: {
    outcome: "require_approval",
    reasonCode: "default_requires_approval",
  },
  store_affect: {
    outcome: "require_approval",
    reasonCode: "default_requires_approval",
  },
  bulk_cleanup: {
    outcome: "deny",
    reasonCode: "default_denies_high_risk_operation",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.some((item) => item === value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readStringArray(
  value: unknown,
  field: string,
  errors: string[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    if (!isNonEmptyString(item)) {
      errors.push(`${field} entries must be non-empty strings`);
      return undefined;
    }
    result.push(item.trim());
  }
  return result;
}

function readEnumArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  errors: string[],
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return undefined;
  }
  const result: T[] = [];
  for (const item of value) {
    if (!isOneOf(item, allowed)) {
      errors.push(`${field} contains unsupported value`);
      return undefined;
    }
    result.push(item);
  }
  return result;
}

function isValidIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function parseDateInput(
  value: Date | string | number | undefined,
): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return new Date();
}

function sensitivityCompare(
  left: LifeOpsPolicySensitivity,
  right: LifeOpsPolicySensitivity,
): number {
  return SENSITIVITY_SCORE[left] - SENSITIVITY_SCORE[right];
}

function compareNumber(
  left: number,
  operator: LifeOpsPolicyComparisonOperator,
  right: number,
): boolean {
  switch (operator) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
    case "gte":
      return left >= right;
    case "gt":
      return left > right;
  }
}

function normalizeRegion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().toUpperCase();
}

function arrayIntersects(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return false;
  return left.some((item) => right.includes(item));
}

function validateEvidence(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  if (value.length === 0) {
    errors.push(`${field} is required for durable policy rules`);
    return;
  }
  for (const item of value) {
    if (!isRecord(item)) {
      errors.push(`${field} entries must be objects`);
      return;
    }
    if (!isOneOf(item.source, LIFEOPS_POLICY_EVIDENCE_SOURCES)) {
      errors.push(`${field}.source is unsupported`);
    }
    if (!isNonEmptyString(item.sourceId)) {
      errors.push(`${field}.sourceId is required`);
    }
    if (!isNonEmptyString(item.actorId)) {
      errors.push(`${field}.actorId is required`);
    }
    if (
      !isNonEmptyString(item.recordedAt) ||
      !isValidIsoDate(item.recordedAt)
    ) {
      errors.push(`${field}.recordedAt must be a valid ISO datetime`);
    }
    if (item.reviewId !== undefined && !isNonEmptyString(item.reviewId)) {
      errors.push(`${field}.reviewId must be a non-empty string when present`);
    }
  }
}

function validateSubjectSelector(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("subject must be an object");
    return;
  }
  if (!isOneOf(value.kind, LIFEOPS_POLICY_SUBJECT_KINDS)) {
    errors.push("subject.kind is unsupported");
  }
  readStringArray(value.ids, "subject.ids", errors);
  readStringArray(value.labels, "subject.labels", errors);
  if (
    value.sensitivityAtLeast !== undefined &&
    !isOneOf(value.sensitivityAtLeast, LIFEOPS_POLICY_SENSITIVITY_LEVELS)
  ) {
    errors.push("subject.sensitivityAtLeast is unsupported");
  }
  if (
    value.sensitivityAtMost !== undefined &&
    !isOneOf(value.sensitivityAtMost, LIFEOPS_POLICY_SENSITIVITY_LEVELS)
  ) {
    errors.push("subject.sensitivityAtMost is unsupported");
  }
}

function validateScopes(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push("scopes must be an object");
    return;
  }
  readEnumArray(
    value.surfaces,
    "scopes.surfaces",
    LIFEOPS_POLICY_SURFACES,
    errors,
  );
  readStringArray(value.regions, "scopes.regions", errors);
  readEnumArray(
    value.channels,
    "scopes.channels",
    LIFEOPS_POLICY_CHANNELS,
    errors,
  );
  readStringArray(value.contactIds, "scopes.contactIds", errors);
  readEnumArray(
    value.resourceKinds,
    "scopes.resourceKinds",
    LIFEOPS_POLICY_RESOURCE_KINDS,
    errors,
  );
  readStringArray(value.resourceIds, "scopes.resourceIds", errors);
}

function validateThresholds(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push("thresholds must be an object");
    return;
  }
  if (
    value.maxAmountUsd !== undefined &&
    !isFiniteNonNegative(value.maxAmountUsd)
  ) {
    errors.push("thresholds.maxAmountUsd must be a non-negative finite number");
  }
  if (
    value.maxBulkItemCount !== undefined &&
    !isFiniteNonNegative(value.maxBulkItemCount)
  ) {
    errors.push(
      "thresholds.maxBulkItemCount must be a non-negative finite number",
    );
  }
  if (
    value.maxRecipientCount !== undefined &&
    !isFiniteNonNegative(value.maxRecipientCount)
  ) {
    errors.push(
      "thresholds.maxRecipientCount must be a non-negative finite number",
    );
  }
  if (
    value.maxSensitivity !== undefined &&
    !isOneOf(value.maxSensitivity, LIFEOPS_POLICY_SENSITIVITY_LEVELS)
  ) {
    errors.push("thresholds.maxSensitivity is unsupported");
  }
  if (
    value.maxContactSensitivity !== undefined &&
    !isOneOf(value.maxContactSensitivity, LIFEOPS_POLICY_SENSITIVITY_LEVELS)
  ) {
    errors.push("thresholds.maxContactSensitivity is unsupported");
  }
}

function validateCondition(
  value: unknown,
  index: number,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`conditions[${index}] must be an object`);
    return;
  }
  const field = `conditions[${index}]`;
  switch (value.kind) {
    case "amount_usd":
    case "bulk_item_count":
    case "recipient_count":
      if (!isOneOf(value.operator, COMPARISON_OPERATORS)) {
        errors.push(`${field}.operator is unsupported`);
      }
      if (!isFiniteNonNegative(value.value)) {
        errors.push(`${field}.value must be a non-negative finite number`);
      }
      return;
    case "request_sensitivity_at_least":
    case "request_sensitivity_at_most":
    case "contact_sensitivity_at_least":
    case "contact_sensitivity_at_most":
      if (!isOneOf(value.value, LIFEOPS_POLICY_SENSITIVITY_LEVELS)) {
        errors.push(`${field}.value is unsupported`);
      }
      return;
    case "currency_is":
      if (!isNonEmptyString(value.value)) {
        errors.push(`${field}.value must be a non-empty string`);
      }
      return;
    default:
      errors.push(`${field}.kind is unsupported`);
  }
}

function validateConditions(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push("conditions must be an array");
    return;
  }
  for (let index = 0; index < value.length; index += 1) {
    validateCondition(value[index], index, errors);
  }
}

function validateEffectiveWindow(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push("effectiveWindow must be an object");
    return;
  }
  if (
    value.startsAt !== undefined &&
    (!isNonEmptyString(value.startsAt) || !isValidIsoDate(value.startsAt))
  ) {
    errors.push("effectiveWindow.startsAt must be a valid ISO datetime");
  }
  if (
    value.endsAt !== undefined &&
    (!isNonEmptyString(value.endsAt) || !isValidIsoDate(value.endsAt))
  ) {
    errors.push("effectiveWindow.endsAt must be a valid ISO datetime");
  }
  if (
    value.timezone !== undefined &&
    (!isNonEmptyString(value.timezone) || !isValidTimeZone(value.timezone))
  ) {
    errors.push("effectiveWindow.timezone must be a valid IANA timezone");
  }
  if (value.daysOfWeek !== undefined) {
    if (!Array.isArray(value.daysOfWeek)) {
      errors.push("effectiveWindow.daysOfWeek must be an array");
    } else {
      for (const day of value.daysOfWeek) {
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          errors.push(
            "effectiveWindow.daysOfWeek entries must be integers 0..6",
          );
          break;
        }
      }
    }
  }
  const start = value.startMinuteOfDay;
  const end = value.endMinuteOfDay;
  if (
    start !== undefined &&
    (typeof start !== "number" ||
      !Number.isInteger(start) ||
      start < 0 ||
      start > 1439)
  ) {
    errors.push("effectiveWindow.startMinuteOfDay must be an integer 0..1439");
  }
  if (
    end !== undefined &&
    (typeof end !== "number" || !Number.isInteger(end) || end < 1 || end > 1440)
  ) {
    errors.push("effectiveWindow.endMinuteOfDay must be an integer 1..1440");
  }
  if ((start === undefined) !== (end === undefined)) {
    errors.push(
      "effectiveWindow.startMinuteOfDay and endMinuteOfDay must be provided together",
    );
  }
}

export function validateLifeOpsPolicyRule(
  rule: unknown,
): LifeOpsPolicyRuleValidation {
  const errors: string[] = [];
  const ruleId =
    isRecord(rule) && isNonEmptyString(rule.id) ? rule.id.trim() : "unknown";

  if (!isRecord(rule)) {
    return {
      valid: false,
      ruleId,
      errors: ["rule must be an object"],
    };
  }

  if (rule.kind !== "lifeops_policy_rule") {
    errors.push("kind must be lifeops_policy_rule");
  }
  if (!isNonEmptyString(rule.id)) {
    errors.push("id is required");
  }
  if (rule.version !== 1) {
    errors.push("version must be 1");
  }
  readEnumArray(
    rule.operations,
    "operations",
    LIFEOPS_POLICY_OPERATIONS,
    errors,
  );
  if (Array.isArray(rule.operations) && rule.operations.length === 0) {
    errors.push("operations must contain at least one operation");
  }
  if (!isOneOf(rule.effect, LIFEOPS_POLICY_EFFECTS)) {
    errors.push("effect is unsupported");
  }
  validateSubjectSelector(rule.subject, errors);
  validateScopes(rule.scopes, errors);
  validateConditions(rule.conditions, errors);
  validateThresholds(rule.thresholds, errors);
  if (!Number.isInteger(rule.precedence)) {
    errors.push("precedence must be an integer");
  }
  validateEffectiveWindow(rule.effectiveWindow, errors);
  if (
    rule.expiresAt !== undefined &&
    (!isNonEmptyString(rule.expiresAt) || !isValidIsoDate(rule.expiresAt))
  ) {
    errors.push("expiresAt must be a valid ISO datetime");
  }
  validateEvidence(rule.evidence, "evidence", errors);
  if (!isOneOf(rule.reviewState, LIFEOPS_POLICY_REVIEW_STATES)) {
    errors.push("reviewState is unsupported");
  }

  return {
    valid: errors.length === 0,
    ruleId,
    errors,
  };
}

function validateRequest(
  request: LifeOpsPolicyEvaluationRequest,
): readonly string[] {
  const errors: string[] = [];
  if (!isNonEmptyString(request.requestId)) {
    errors.push("requestId is required");
  }
  if (!isOneOf(request.operation, LIFEOPS_POLICY_OPERATIONS)) {
    errors.push("operation is unsupported");
  }
  if (!isNonEmptyString(request.requestedBy)) {
    errors.push("requestedBy is required");
  }
  if (!isOneOf(request.sensitivity, LIFEOPS_POLICY_SENSITIVITY_LEVELS)) {
    errors.push("sensitivity is unsupported");
  }
  if (
    request.contactSensitivity !== undefined &&
    !isOneOf(request.contactSensitivity, LIFEOPS_POLICY_SENSITIVITY_LEVELS)
  ) {
    errors.push("contactSensitivity is unsupported");
  }
  if (!isRecord(request.scope)) {
    errors.push("scope must be an object");
  } else {
    if (!isOneOf(request.scope.surface, LIFEOPS_POLICY_SURFACES)) {
      errors.push("scope.surface is unsupported");
    }
    if (
      request.scope.channel !== undefined &&
      !isOneOf(request.scope.channel, LIFEOPS_POLICY_CHANNELS)
    ) {
      errors.push("scope.channel is unsupported");
    }
    if (request.scope.resource) {
      if (!isRecord(request.scope.resource)) {
        errors.push("scope.resource must be an object");
      } else {
        if (
          !isOneOf(request.scope.resource.kind, LIFEOPS_POLICY_RESOURCE_KINDS)
        ) {
          errors.push("scope.resource.kind is unsupported");
        }
        if (!isNonEmptyString(request.scope.resource.id)) {
          errors.push("scope.resource.id is required");
        }
      }
    }
  }
  if (!isRecord(request.subject)) {
    errors.push("subject must be an object");
  } else {
    if (!isOneOf(request.subject.kind, LIFEOPS_POLICY_SUBJECT_KINDS)) {
      errors.push("subject.kind is unsupported");
    }
    if (!isNonEmptyString(request.subject.id)) {
      errors.push("subject.id is required");
    }
    if (
      !isOneOf(request.subject.sensitivity, LIFEOPS_POLICY_SENSITIVITY_LEVELS)
    ) {
      errors.push("subject.sensitivity is unsupported");
    }
  }
  if (
    request.amountUsd !== undefined &&
    !isFiniteNonNegative(request.amountUsd)
  ) {
    errors.push("amountUsd must be a non-negative finite number");
  }
  if (
    request.operation === "spend_money" &&
    !isFiniteNonNegative(request.amountUsd)
  ) {
    errors.push("amountUsd is required for spend_money");
  }
  if (
    request.bulkItemCount !== undefined &&
    !isFiniteNonNegative(request.bulkItemCount)
  ) {
    errors.push("bulkItemCount must be a non-negative finite number");
  }
  if (
    request.operation === "bulk_cleanup" &&
    !isFiniteNonNegative(request.bulkItemCount)
  ) {
    errors.push("bulkItemCount is required for bulk_cleanup");
  }
  if (
    request.recipientCount !== undefined &&
    !isFiniteNonNegative(request.recipientCount)
  ) {
    errors.push("recipientCount must be a non-negative finite number");
  }
  if (request.now !== undefined && parseDateInput(request.now) === null) {
    errors.push("now must be a valid date");
  }
  return errors;
}

function evidenceIds(rule: LifeOpsPolicyRule): readonly string[] {
  return rule.evidence.map((item) => `${item.source}:${item.sourceId}`);
}

function calculateSpecificity(rule: LifeOpsPolicyRule): number {
  let score = 0;
  if (rule.operations.length < LIFEOPS_POLICY_OPERATIONS.length) score += 2;
  if (rule.subject.kind !== "any") score += 2;
  score += (rule.subject.ids?.length ?? 0) * 4;
  score += (rule.subject.labels?.length ?? 0) * 2;
  if (rule.subject.sensitivityAtLeast) score += 1;
  if (rule.subject.sensitivityAtMost) score += 1;

  const scopes = rule.scopes;
  if (scopes) {
    score += (scopes.surfaces?.length ?? 0) * 2;
    score += (scopes.regions?.length ?? 0) * 2;
    score += (scopes.channels?.length ?? 0) * 2;
    score += (scopes.contactIds?.length ?? 0) * 4;
    score += (scopes.resourceKinds?.length ?? 0) * 2;
    score += (scopes.resourceIds?.length ?? 0) * 4;
  }

  const thresholds = rule.thresholds;
  if (thresholds) {
    if (thresholds.maxAmountUsd !== undefined) score += 2;
    if (thresholds.maxBulkItemCount !== undefined) score += 2;
    if (thresholds.maxRecipientCount !== undefined) score += 2;
    if (thresholds.maxSensitivity !== undefined) score += 1;
    if (thresholds.maxContactSensitivity !== undefined) score += 1;
  }

  score += (rule.conditions?.length ?? 0) * 3;
  if (rule.effectiveWindow) score += 1;
  return score;
}

function effectiveWindowContains(
  window: LifeOpsPolicyEffectiveWindow,
  now: Date,
): boolean {
  if (window.startsAt && now.getTime() < Date.parse(window.startsAt)) {
    return false;
  }
  if (window.endsAt && now.getTime() >= Date.parse(window.endsAt)) {
    return false;
  }
  if (window.daysOfWeek || window.startMinuteOfDay !== undefined) {
    const timezone = window.timezone ?? "UTC";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const weekday = parts.find((part) => part.type === "weekday")?.value;
    const day = weekdayToIndex(weekday);
    if (
      window.daysOfWeek &&
      (day === null || !window.daysOfWeek.includes(day))
    ) {
      return false;
    }
    if (
      window.startMinuteOfDay !== undefined &&
      window.endMinuteOfDay !== undefined
    ) {
      const hourText = parts.find((part) => part.type === "hour")?.value;
      const minuteText = parts.find((part) => part.type === "minute")?.value;
      const hour = hourText ? Number.parseInt(hourText, 10) % 24 : 0;
      const minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
      const minuteOfDay = hour * 60 + minute;
      return minuteWithinWindow(
        minuteOfDay,
        window.startMinuteOfDay,
        window.endMinuteOfDay,
      );
    }
  }
  return true;
}

function weekdayToIndex(value: string | undefined): number | null {
  switch (value) {
    case "Sun":
      return 0;
    case "Mon":
      return 1;
    case "Tue":
      return 2;
    case "Wed":
      return 3;
    case "Thu":
      return 4;
    case "Fri":
      return 5;
    case "Sat":
      return 6;
    default:
      return null;
  }
}

function minuteWithinWindow(
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) return false;
  if (startMinute > endMinute) {
    return minuteOfDay >= startMinute || minuteOfDay < endMinute;
  }
  return minuteOfDay >= startMinute && minuteOfDay < endMinute;
}

function matchesSubject(
  selector: LifeOpsPolicySubjectSelector,
  subject: LifeOpsPolicyRequestSubject,
): boolean {
  if (selector.kind !== "any" && selector.kind !== subject.kind) {
    return false;
  }
  if (selector.ids && !selector.ids.includes(subject.id)) {
    return false;
  }
  if (selector.labels && !arrayIntersects(selector.labels, subject.labels)) {
    return false;
  }
  if (
    selector.sensitivityAtLeast &&
    sensitivityCompare(subject.sensitivity, selector.sensitivityAtLeast) < 0
  ) {
    return false;
  }
  if (
    selector.sensitivityAtMost &&
    sensitivityCompare(subject.sensitivity, selector.sensitivityAtMost) > 0
  ) {
    return false;
  }
  return true;
}

function matchesScope(
  scopes: LifeOpsPolicyScopeSelector | undefined,
  request: LifeOpsPolicyEvaluationRequest,
): boolean {
  if (!scopes) return true;
  if (scopes.surfaces && !scopes.surfaces.includes(request.scope.surface)) {
    return false;
  }
  if (scopes.regions) {
    const requestRegion = normalizeRegion(request.scope.region);
    const allowedRegions = scopes.regions.map((region) =>
      normalizeRegion(region),
    );
    if (!requestRegion || !allowedRegions.includes(requestRegion)) {
      return false;
    }
  }
  if (
    scopes.channels &&
    (!request.scope.channel || !scopes.channels.includes(request.scope.channel))
  ) {
    return false;
  }
  if (
    scopes.contactIds &&
    (!request.scope.contactId ||
      !scopes.contactIds.includes(request.scope.contactId))
  ) {
    return false;
  }
  if (
    scopes.resourceKinds &&
    (!request.scope.resource ||
      !scopes.resourceKinds.includes(request.scope.resource.kind))
  ) {
    return false;
  }
  if (
    scopes.resourceIds &&
    (!request.scope.resource ||
      !scopes.resourceIds.includes(request.scope.resource.id))
  ) {
    return false;
  }
  return true;
}

function thresholdsSatisfied(
  thresholds: LifeOpsPolicyThresholds | undefined,
  request: LifeOpsPolicyEvaluationRequest,
): boolean {
  if (!thresholds) return true;
  if (
    thresholds.maxAmountUsd !== undefined &&
    (request.amountUsd === undefined ||
      request.amountUsd > thresholds.maxAmountUsd)
  ) {
    return false;
  }
  if (
    thresholds.maxBulkItemCount !== undefined &&
    (request.bulkItemCount === undefined ||
      request.bulkItemCount > thresholds.maxBulkItemCount)
  ) {
    return false;
  }
  if (
    thresholds.maxRecipientCount !== undefined &&
    (request.recipientCount === undefined ||
      request.recipientCount > thresholds.maxRecipientCount)
  ) {
    return false;
  }
  if (
    thresholds.maxSensitivity !== undefined &&
    sensitivityCompare(request.sensitivity, thresholds.maxSensitivity) > 0
  ) {
    return false;
  }
  if (
    thresholds.maxContactSensitivity !== undefined &&
    (request.contactSensitivity === undefined ||
      sensitivityCompare(
        request.contactSensitivity,
        thresholds.maxContactSensitivity,
      ) > 0)
  ) {
    return false;
  }
  return true;
}

function conditionSatisfied(
  condition: LifeOpsPolicyCondition,
  request: LifeOpsPolicyEvaluationRequest,
): boolean {
  switch (condition.kind) {
    case "amount_usd":
      return (
        request.amountUsd !== undefined &&
        compareNumber(request.amountUsd, condition.operator, condition.value)
      );
    case "bulk_item_count":
      return (
        request.bulkItemCount !== undefined &&
        compareNumber(
          request.bulkItemCount,
          condition.operator,
          condition.value,
        )
      );
    case "recipient_count":
      return (
        request.recipientCount !== undefined &&
        compareNumber(
          request.recipientCount,
          condition.operator,
          condition.value,
        )
      );
    case "request_sensitivity_at_least":
      return sensitivityCompare(request.sensitivity, condition.value) >= 0;
    case "request_sensitivity_at_most":
      return sensitivityCompare(request.sensitivity, condition.value) <= 0;
    case "contact_sensitivity_at_least":
      return (
        request.contactSensitivity !== undefined &&
        sensitivityCompare(request.contactSensitivity, condition.value) >= 0
      );
    case "contact_sensitivity_at_most":
      return (
        request.contactSensitivity !== undefined &&
        sensitivityCompare(request.contactSensitivity, condition.value) <= 0
      );
    case "currency_is":
      return (
        request.currency !== undefined &&
        request.currency.trim().toUpperCase() ===
          condition.value.trim().toUpperCase()
      );
  }
}

function conditionsSatisfied(
  conditions: readonly LifeOpsPolicyCondition[] | undefined,
  request: LifeOpsPolicyEvaluationRequest,
): boolean {
  if (!conditions) return true;
  return conditions.every((condition) =>
    conditionSatisfied(condition, request),
  );
}

function matchRule(
  rule: LifeOpsPolicyRule,
  request: LifeOpsPolicyEvaluationRequest,
  now: Date,
): RuleMatch {
  if (rule.reviewState !== "active") {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "review_state_not_active" },
    };
  }
  if (!rule.operations.includes(request.operation)) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "operation_mismatch" },
    };
  }
  if (rule.expiresAt && now.getTime() >= Date.parse(rule.expiresAt)) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "expired" },
    };
  }
  if (
    rule.effectiveWindow &&
    !effectiveWindowContains(rule.effectiveWindow, now)
  ) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "outside_effective_window" },
    };
  }
  if (!matchesSubject(rule.subject, request.subject)) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "subject_mismatch" },
    };
  }
  if (!matchesScope(rule.scopes, request)) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "scope_mismatch" },
    };
  }
  if (!thresholdsSatisfied(rule.thresholds, request)) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "threshold_not_satisfied" },
    };
  }
  if (!conditionsSatisfied(rule.conditions, request)) {
    return {
      matched: false,
      ignored: { ruleId: rule.id, reason: "condition_not_satisfied" },
    };
  }

  const specificity = calculateSpecificity(rule);
  return {
    matched: true,
    rule,
    auditRef: {
      ruleId: rule.id,
      effect: rule.effect,
      precedence: rule.precedence,
      specificity,
      evidenceIds: evidenceIds(rule),
    },
  };
}

function buildDecision(args: {
  request: LifeOpsPolicyEvaluationRequest;
  now: Date;
  outcome: LifeOpsPolicyDecisionOutcome;
  approvalMode: "approval_queue" | "prompt_user_first" | null;
  reasons: readonly LifeOpsPolicyDecisionReason[];
  selectedRules: readonly LifeOpsPolicyRuleAuditRef[];
  matchedRules: readonly LifeOpsPolicyRuleAuditRef[];
  ignoredRules: readonly LifeOpsPolicyIgnoredRuleRecord[];
  invalidRules: readonly LifeOpsPolicyInvalidRuleRecord[];
}): LifeOpsPolicyDecision {
  const reasonCodes = args.reasons.map((reason) => reason.code);
  const evaluatedAt = args.now.toISOString();
  return {
    requestId: args.request.requestId,
    operation: args.request.operation,
    outcome: args.outcome,
    approvalMode: args.approvalMode,
    reasons: args.reasons,
    record: {
      decisionId: `lifeops-policy:${args.request.requestId}:${args.now.getTime()}`,
      evaluatedAt,
      requestId: args.request.requestId,
      requestedBy: args.request.requestedBy,
      operation: args.request.operation,
      outcome: args.outcome,
      approvalMode: args.approvalMode,
      reasonCodes,
      selectedRules: args.selectedRules,
      matchedRules: args.matchedRules,
      ignoredRules: args.ignoredRules,
      invalidRules: args.invalidRules,
    },
  };
}

function chooseTopMatches(
  matches: readonly {
    readonly rule: LifeOpsPolicyRule;
    readonly auditRef: LifeOpsPolicyRuleAuditRef;
  }[],
): readonly {
  readonly rule: LifeOpsPolicyRule;
  readonly auditRef: LifeOpsPolicyRuleAuditRef;
}[] {
  const maxPrecedence = Math.max(
    ...matches.map((match) => match.auditRef.precedence),
  );
  const samePrecedence = matches.filter(
    (match) => match.auditRef.precedence === maxPrecedence,
  );
  const maxSpecificity = Math.max(
    ...samePrecedence.map((match) => match.auditRef.specificity),
  );
  return samePrecedence.filter(
    (match) => match.auditRef.specificity === maxSpecificity,
  );
}

function chooseEffect(
  matches: readonly LifeOpsPolicyRule[],
): LifeOpsPolicyEffect {
  let effect: LifeOpsPolicyEffect = "allow";
  for (const match of matches) {
    if (EFFECT_SEVERITY[match.effect] > EFFECT_SEVERITY[effect]) {
      effect = match.effect;
    }
    if (
      EFFECT_SEVERITY[match.effect] === EFFECT_SEVERITY[effect] &&
      match.effect === "prompt_user_first"
    ) {
      effect = "prompt_user_first";
    }
  }
  return effect;
}

function reasonForEffect(
  effect: LifeOpsPolicyEffect,
): LifeOpsPolicyDecisionReasonCode {
  switch (effect) {
    case "allow":
      return "allowed_by_rule";
    case "deny":
      return "denied_by_rule";
    case "require_approval":
      return "approval_required_by_rule";
    case "prompt_user_first":
      return "prompt_user_first";
  }
}

export class LifeOpsPolicyMemoryEvaluator {
  private readonly rules: readonly LifeOpsPolicyRule[];

  constructor(rules: readonly LifeOpsPolicyRule[]) {
    this.rules = rules;
  }

  evaluate(request: LifeOpsPolicyEvaluationRequest): LifeOpsPolicyDecision {
    return evaluateLifeOpsPolicyMemory(request, this.rules);
  }
}

export function evaluateLifeOpsPolicyMemory(
  request: LifeOpsPolicyEvaluationRequest,
  rules: readonly LifeOpsPolicyRule[],
): LifeOpsPolicyDecision {
  const now = parseDateInput(request.now);
  const effectiveNow = now ?? new Date(0);
  const requestErrors = validateRequest(request);
  if (requestErrors.length > 0 || now === null) {
    const errors =
      now === null
        ? [...requestErrors, "now must be a valid date"]
        : requestErrors;
    return buildDecision({
      request,
      now: effectiveNow,
      outcome: "deny",
      approvalMode: null,
      reasons: [
        {
          code: "malformed_request",
          detail: { errorCount: errors.length },
        },
      ],
      selectedRules: [],
      matchedRules: [],
      ignoredRules: [],
      invalidRules: [
        {
          ruleId: "request",
          errors,
        },
      ],
    });
  }

  const invalidRules: LifeOpsPolicyInvalidRuleRecord[] = [];
  const seenRuleIds = new Set<string>();

  for (const rule of rules) {
    const validation = validateLifeOpsPolicyRule(rule);
    if (!validation.valid) {
      invalidRules.push({
        ruleId: validation.ruleId,
        errors: validation.errors,
      });
    }
    if (seenRuleIds.has(validation.ruleId)) {
      invalidRules.push({
        ruleId: validation.ruleId,
        errors: ["duplicate rule id"],
      });
    }
    seenRuleIds.add(validation.ruleId);
  }

  if (invalidRules.length > 0) {
    const duplicateRuleIds = invalidRules.filter((rule) =>
      rule.errors.includes("duplicate rule id"),
    );
    const reasons: LifeOpsPolicyDecisionReason[] = [
      {
        code: "malformed_rule",
        detail: { invalidRuleCount: invalidRules.length },
      },
    ];
    if (duplicateRuleIds.length > 0) {
      reasons.push({
        code: "duplicate_rule_id",
        ruleIds: duplicateRuleIds.map((rule) => rule.ruleId),
      });
    }
    return buildDecision({
      request,
      now: effectiveNow,
      outcome: "deny",
      approvalMode: null,
      reasons,
      selectedRules: [],
      matchedRules: [],
      ignoredRules: [],
      invalidRules,
    });
  }

  const matchedRules: {
    readonly rule: LifeOpsPolicyRule;
    readonly auditRef: LifeOpsPolicyRuleAuditRef;
  }[] = [];
  const ignoredRules: LifeOpsPolicyIgnoredRuleRecord[] = [];

  for (const rule of rules) {
    const result = matchRule(rule, request, effectiveNow);
    if (result.matched === true) {
      matchedRules.push({
        rule: result.rule,
        auditRef: result.auditRef,
      });
    } else {
      ignoredRules.push(result.ignored);
    }
  }

  if (matchedRules.length === 0) {
    const fallback = DEFAULT_OUTCOME_BY_OPERATION[request.operation];
    return buildDecision({
      request,
      now: effectiveNow,
      outcome: fallback.outcome,
      approvalMode:
        fallback.outcome === "require_approval" ? "approval_queue" : null,
      reasons: [{ code: fallback.reasonCode }],
      selectedRules: [],
      matchedRules: [],
      ignoredRules,
      invalidRules: [],
    });
  }

  const topMatches = chooseTopMatches(matchedRules);
  const selectedEffect = chooseEffect(topMatches.map((match) => match.rule));
  const selectedRules = topMatches
    .filter((match) => match.rule.effect === selectedEffect)
    .map((match) => match.auditRef);
  const topEffects = new Set(topMatches.map((match) => match.rule.effect));
  const reasons: LifeOpsPolicyDecisionReason[] = [
    {
      code: reasonForEffect(selectedEffect),
      ruleIds: selectedRules.map((rule) => rule.ruleId),
    },
  ];
  if (topEffects.size > 1) {
    reasons.push({
      code: "conflicting_top_rank_rules_resolved_conservatively",
      ruleIds: topMatches.map((match) => match.rule.id),
    });
  }

  return buildDecision({
    request,
    now: effectiveNow,
    outcome: OUTCOME_BY_EFFECT[selectedEffect],
    approvalMode: APPROVAL_MODE_BY_EFFECT[selectedEffect],
    reasons,
    selectedRules,
    matchedRules: matchedRules.map((match) => match.auditRef),
    ignoredRules,
    invalidRules: [],
  });
}
