/**
 * Typed household coordination contracts for role-scoped access and
 * approval-backed schedule agreements. Calendar events remain calendar-owned;
 * these records capture who may see or change household plans and what every
 * affected adult actually approved.
 */
import { ElizaError } from "@elizaos/core";
import { isValidTimeZone } from "@elizaos/shared";

export const HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID =
  "household.schedule.proposal.approval" as const;
export const DEFAULT_HOUSEHOLD_ID = "household:default" as const;

/**
 * The exact decision line an affected party sends back over a connector.
 * Outbound approval prompts and the inbound parser both derive from this
 * builder so the taught command and the accepted grammar cannot drift.
 */
export function householdApprovalCommandText(
  decision: "approve" | "reject",
  approvalRequestId: string,
): string {
  return `${decision} household approval ${approvalRequestId}`;
}

/**
 * Connector-delivered approval request for an affected party. The taught
 * commands are embedded after prose on the same line so a quoted echo of this
 * prompt cannot satisfy the whole-message inbound parser.
 */
export function householdApprovalRequestPrompt(input: {
  approvalRequestId: string;
  reason: string;
}): string {
  const approve = householdApprovalCommandText(
    "approve",
    input.approvalRequestId,
  );
  const reject = householdApprovalCommandText(
    "reject",
    input.approvalRequestId,
  );
  return [
    input.reason,
    "",
    `To approve, reply with only this command: ${approve}`,
    `To decline, reply with only this command: ${reject}`,
    `You may add a short note on that same line, for example: "${approve} — works for us". Do not include a greeting, signature, or quoted history.`,
  ].join("\n");
}

export const HOUSEHOLD_ROLES = [
  "owner",
  "co_parent",
  "current_partner",
  "caregiver",
  "child",
  "professional",
] as const;
export type HouseholdRole = (typeof HOUSEHOLD_ROLES)[number];

export const HOUSEHOLD_ACCESS_SCOPES = [
  "household.visibility",
  "calendar.freebusy",
  "calendar.details",
  "calendar.mutate",
  "schedule.propose",
  "schedule.approve",
  "household.export",
] as const;
export type HouseholdAccessScope = (typeof HOUSEHOLD_ACCESS_SCOPES)[number];

export const HOUSEHOLD_PROPOSAL_STATUSES = [
  "pending",
  "superseded",
  "accepted",
  "rejected",
  "expired",
  "invalidated",
] as const;
export type HouseholdProposalStatus =
  (typeof HOUSEHOLD_PROPOSAL_STATUSES)[number];

export interface HouseholdRoleBinding {
  householdId: string;
  entityId: string;
  role: HouseholdRole;
  relationshipId: string | null;
  subjectEntityIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdAccessGrant {
  id: string;
  agentId: string;
  householdId: string;
  principalEntityId: string;
  relationshipId: string | null;
  role: HouseholdRole;
  subjectEntityIds: string[];
  scopes: HouseholdAccessScope[];
  issuedByEntityId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByEntityId: string | null;
  revocationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdCustodyException {
  childEntityId: string;
  fromAt: string;
  toAt: string;
  normalCustodianEntityId: string;
  substituteCustodianEntityId: string;
  authorityBaselineRelationshipId: string;
  authorityBaselineRevisionSha256?: string | null;
  reason: string;
}

export interface HouseholdCustodyAuthorityBaseline {
  householdId: string;
  relationshipId: string;
  childEntityId: string;
  custodianEntityIds: string[];
  revision: number;
  revisionSha256: string;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdScheduleTerms {
  summary: string;
  startAt: string;
  endAt: string;
  timezone: string;
  childEntityIds: string[];
  location: string | null;
  notes: string | null;
  custodyException: HouseholdCustodyException | null;
}

export interface HouseholdScheduleProposal {
  proposalId: string;
  agentId: string;
  householdId: string;
  version: number;
  coordinationId: string;
  baseAgreementVersion: number;
  terms: HouseholdScheduleTerms;
  affectedPartyEntityIds: string[];
  requiredApproverEntityIds: string[];
  createdByEntityId: string;
  contentSha256: string;
  status: HouseholdProposalStatus;
  materialChange: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdProposalApproval {
  id: string;
  agentId: string;
  proposalId: string;
  proposalVersion: number;
  partyEntityId: string;
  approvalRequestId: string;
  invalidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One approval row a proposal transition invalidated, carried with the party
 * it was raised against. The repository knows that party at the moment it
 * rejects, expires, or revises the proposal; binding it to the row here keeps
 * callers from having to reconstruct the subject the queue scopes reads and
 * writes by.
 */
export interface InvalidatedProposalApproval {
  readonly requestId: string;
  readonly partyEntityId: string;
}

export interface HouseholdScheduleAgreement {
  id: string;
  agentId: string;
  householdId: string;
  coordinationId: string;
  version: number;
  proposalId: string;
  proposalVersion: number;
  terms: HouseholdScheduleTerms;
  affectedPartyEntityIds: string[];
  approvedByEntityIds: string[];
  activatedAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface HouseholdCoordinationHead {
  id: string;
  agentId: string;
  householdId: string;
  coordinationId: string;
  currentAgreementVersion: number;
  currentAgreementId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const HOUSEHOLD_AUDIT_KINDS = [
  "household_role_bound",
  "household_custody_authority_set",
  "household_custody_authority_revoked",
  "household_grant_issued",
  "household_grant_revoked",
  "household_proposal_created",
  "household_proposal_revised",
  "household_proposal_approved",
  "household_proposal_invalidated",
  "household_agreement_activated",
  "household_export_read",
] as const;
export type HouseholdAuditKind = (typeof HOUSEHOLD_AUDIT_KINDS)[number];

export interface HouseholdAuditRecord {
  id: string;
  kind: HouseholdAuditKind;
  ownerId: string;
  reason: string;
  inputs: Record<string, unknown>;
  decision: Record<string, unknown>;
  actor: "agent" | "user" | "workflow";
  createdAt: string;
}

export interface HouseholdExportScheduleEntry {
  householdId: string;
  coordinationId: string;
  /**
   * Visible schedule subjects are structural authorization metadata, not
   * inferred from summary text. Non-owner exports contain only subjects
   * already covered by the caller's active grants.
   */
  subjectEntityIds: string[];
  proposalId: string | null;
  proposalVersion: number | null;
  agreementId: string | null;
  agreementVersion: number | null;
  startAt: string;
  endAt: string;
  details: HouseholdScheduleTerms | null;
  state: "proposal" | "agreement";
}

export interface HouseholdScopedExport {
  generatedAt: string;
  householdId: string;
  principalEntityId: string;
  effectiveScopes: HouseholdAccessScope[];
  visibleSubjectEntityIds: string[];
  roles: HouseholdRoleBinding[];
  grants: HouseholdAccessGrant[];
  schedules: HouseholdExportScheduleEntry[];
  audit: HouseholdAuditRecord[];
}

export type HouseholdErrorCode =
  | "HOUSEHOLD_ACCESS_DENIED"
  | "HOUSEHOLD_ENTITY_NOT_FOUND"
  | "HOUSEHOLD_GRANT_EXPIRED"
  | "HOUSEHOLD_GRANT_REVOKED"
  | "HOUSEHOLD_INVALID_CONTRACT"
  | "HOUSEHOLD_PARTY_APPROVAL_UNDELIVERED"
  | "HOUSEHOLD_PARTY_APPROVAL_UNROUTABLE"
  | "HOUSEHOLD_PROPOSAL_CONFLICT"
  | "HOUSEHOLD_PROPOSAL_NOT_FOUND"
  | "HOUSEHOLD_STALE_APPROVAL"
  | "HOUSEHOLD_STALE_BASE_AGREEMENT";

export class HouseholdCoordinationError extends ElizaError {
  override readonly name = "HouseholdCoordinationError";

  constructor(
    message: string,
    code: HouseholdErrorCode,
    context?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, {
      code,
      context,
      cause,
      severity:
        code === "HOUSEHOLD_ENTITY_NOT_FOUND" ||
        code === "HOUSEHOLD_INVALID_CONTRACT"
          ? "fatal"
          : "ephemeral",
    });
  }
}

export function isHouseholdRole(value: string): value is HouseholdRole {
  return HOUSEHOLD_ROLES.some((role) => role === value);
}

export function isHouseholdAccessScope(
  value: string,
): value is HouseholdAccessScope {
  return HOUSEHOLD_ACCESS_SCOPES.some((scope) => scope === value);
}

export function isHouseholdProposalStatus(
  value: string,
): value is HouseholdProposalStatus {
  return HOUSEHOLD_PROPOSAL_STATUSES.some((status) => status === value);
}

export function isHouseholdAuditKind(
  value: string,
): value is HouseholdAuditKind {
  return HOUSEHOLD_AUDIT_KINDS.some((kind) => kind === value);
}

export const ROLE_SCOPE_LIMITS: Readonly<
  Record<HouseholdRole, readonly HouseholdAccessScope[]>
> = {
  owner: HOUSEHOLD_ACCESS_SCOPES,
  co_parent: HOUSEHOLD_ACCESS_SCOPES,
  current_partner: HOUSEHOLD_ACCESS_SCOPES,
  caregiver: [
    "household.visibility",
    "calendar.freebusy",
    "calendar.details",
    "schedule.propose",
    "household.export",
  ],
  child: ["household.visibility", "calendar.freebusy"],
  professional: [
    "household.visibility",
    "calendar.freebusy",
    "calendar.details",
    "schedule.propose",
    "household.export",
  ],
};

/**
 * Closure of the scope-implication lattice. Broader authorities always carry
 * the narrower ones they depend on: mutating a schedule implies proposing
 * changes to it, approving implies reading event detail, proposing implies
 * free/busy visibility, and every calendar or export authority implies basic
 * household visibility. Used both when a grant is issued and when a persisted
 * grant (possibly written before a scope existed) is checked, so stored scope
 * lists never need migration.
 */
export function expandGrantScopes(
  scopes: readonly HouseholdAccessScope[],
): HouseholdAccessScope[] {
  const expanded = new Set(scopes);
  if (expanded.has("calendar.mutate")) {
    expanded.add("schedule.propose");
    expanded.add("calendar.details");
  }
  if (expanded.has("schedule.approve")) {
    expanded.add("calendar.details");
  }
  if (expanded.has("schedule.propose")) {
    expanded.add("calendar.freebusy");
  }
  if (expanded.has("calendar.details")) {
    expanded.add("calendar.freebusy");
  }
  if (expanded.has("calendar.freebusy") || expanded.has("household.export")) {
    expanded.add("household.visibility");
  }
  return HOUSEHOLD_ACCESS_SCOPES.filter((scope) => expanded.has(scope));
}

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value, index) => {
          if (typeof value !== "string") {
            throw new HouseholdCoordinationError(
              "Household string collection contains a non-string value",
              "HOUSEHOLD_INVALID_CONTRACT",
              { index },
            );
          }
          return value.trim();
        })
        .filter(Boolean),
    ),
  ).sort();
}

export function normalizeGrantScopes(
  role: HouseholdRole,
  requestedScopes: readonly HouseholdAccessScope[],
): HouseholdAccessScope[] {
  const maximum = ROLE_SCOPE_LIMITS[role];
  const requested = expandGrantScopes(requestedScopes);
  const forbidden = requested.filter((scope) => !maximum.includes(scope));
  if (forbidden.length > 0) {
    throw new HouseholdCoordinationError(
      `Role ${role} cannot receive scopes: ${forbidden.join(", ")}`,
      "HOUSEHOLD_ACCESS_DENIED",
      { role, forbidden },
    );
  }
  return requested;
}

const RFC3339_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function timezoneOffsetAt(instant: Date, timezone: string): string {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
    hour: "2-digit",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  if (value === "GMT") return "+00:00";
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(value ?? "");
  if (!match?.[1]) {
    throw new HouseholdCoordinationError(
      "Could not resolve the IANA time-zone offset at the supplied instant",
      "HOUSEHOLD_INVALID_CONTRACT",
      { timezone, instant: instant.toISOString() },
    );
  }
  return match[1];
}

function localDateTimeAt(
  instant: Date,
  timezone: string,
): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: parts.year ?? "",
    month: parts.month ?? "",
    day: parts.day ?? "",
    hour: parts.hour ?? "",
    minute: parts.minute ?? "",
    second: parts.second ?? "",
  };
}

function requireZonedInstant(
  value: string,
  field: string,
  timezone: string,
): string {
  if (typeof value !== "string" || !RFC3339_INSTANT_PATTERN.test(value)) {
    throw new HouseholdCoordinationError(
      `${field} must be an RFC3339 timestamp with an explicit offset`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value },
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new HouseholdCoordinationError(
      `${field} must be a valid RFC3339 timestamp`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value },
    );
  }
  const instant = new Date(timestamp);
  // Persisted schedule instants are normalized to Z, so Z is the canonical
  // transport encoding. A numeric offset additionally claims a local civil
  // time and must match the named zone, which rejects skipped-time guesses.
  const suppliedOffset = /([+-]\d{2}:\d{2})$/.exec(value)?.[1];
  const suppliedLocal = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(
    value,
  );
  const resolvedLocal = localDateTimeAt(instant, timezone);
  if (
    suppliedOffset !== undefined &&
    (timezoneOffsetAt(instant, timezone) !== suppliedOffset ||
      !suppliedLocal ||
      resolvedLocal.year !== suppliedLocal[1] ||
      resolvedLocal.month !== suppliedLocal[2] ||
      resolvedLocal.day !== suppliedLocal[3] ||
      resolvedLocal.hour !== suppliedLocal[4] ||
      resolvedLocal.minute !== suppliedLocal[5] ||
      resolvedLocal.second !== suppliedLocal[6])
  ) {
    throw new HouseholdCoordinationError(
      `${field} offset is inconsistent with ${timezone} at that instant`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field, value, timezone },
    );
  }
  return instant.toISOString();
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new HouseholdCoordinationError(
      `${field} must be a string`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new HouseholdCoordinationError(
      `${field} is required`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return normalized;
}

export function normalizeHouseholdIdentifier(
  value: string,
  field: string,
): string {
  const normalized = requireText(value, field);
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (normalized.length > 512 || hasControlCharacter) {
    throw new HouseholdCoordinationError(
      `${field} contains invalid identifier characters or exceeds 512 characters`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return normalized;
}

export function normalizeHouseholdIdentifiers(
  values: readonly string[],
  field: string,
): string[] {
  if (!Array.isArray(values)) {
    throw new HouseholdCoordinationError(
      `${field} must be an array of identifiers`,
      "HOUSEHOLD_INVALID_CONTRACT",
      { field },
    );
  }
  return uniqueStrings(
    values.map((value, index) =>
      normalizeHouseholdIdentifier(value, `${field}[${index}]`),
    ),
  );
}

export function normalizeScheduleTerms(
  input: HouseholdScheduleTerms,
): HouseholdScheduleTerms {
  const timezone = requireText(input.timezone, "timezone");
  if (!isValidTimeZone(timezone)) {
    throw new HouseholdCoordinationError(
      "timezone must be a valid IANA time zone",
      "HOUSEHOLD_INVALID_CONTRACT",
      { timezone },
    );
  }
  const startAt = requireZonedInstant(input.startAt, "startAt", timezone);
  const endAt = requireZonedInstant(input.endAt, "endAt", timezone);
  if (Date.parse(endAt) <= Date.parse(startAt)) {
    throw new HouseholdCoordinationError(
      "endAt must be after startAt",
      "HOUSEHOLD_INVALID_CONTRACT",
      { startAt, endAt },
    );
  }
  const childEntityIds = normalizeHouseholdIdentifiers(
    input.childEntityIds,
    "childEntityIds",
  );
  let custodyException: HouseholdCustodyException | null = null;
  if (input.custodyException) {
    const fromAt = requireZonedInstant(
      input.custodyException.fromAt,
      "custody.fromAt",
      timezone,
    );
    const toAt = requireZonedInstant(
      input.custodyException.toAt,
      "custody.toAt",
      timezone,
    );
    const childEntityId = normalizeHouseholdIdentifier(
      input.custodyException.childEntityId,
      "custody.childEntityId",
    );
    const normalCustodianEntityId = normalizeHouseholdIdentifier(
      input.custodyException.normalCustodianEntityId,
      "custody.normalCustodianEntityId",
    );
    const substituteCustodianEntityId = normalizeHouseholdIdentifier(
      input.custodyException.substituteCustodianEntityId,
      "custody.substituteCustodianEntityId",
    );
    if (Date.parse(toAt) <= Date.parse(fromAt)) {
      throw new HouseholdCoordinationError(
        "custody exception toAt must be after fromAt",
        "HOUSEHOLD_INVALID_CONTRACT",
        { fromAt, toAt },
      );
    }
    if (
      Date.parse(fromAt) < Date.parse(startAt) ||
      Date.parse(toAt) > Date.parse(endAt)
    ) {
      throw new HouseholdCoordinationError(
        "custody exception must fit inside the proposed interval",
        "HOUSEHOLD_INVALID_CONTRACT",
        { startAt, endAt, fromAt, toAt },
      );
    }
    if (normalCustodianEntityId === substituteCustodianEntityId) {
      throw new HouseholdCoordinationError(
        "custody exception requires distinct custodians",
        "HOUSEHOLD_INVALID_CONTRACT",
      );
    }
    if (!childEntityIds.includes(childEntityId)) {
      throw new HouseholdCoordinationError(
        "custody exception child must be listed in childEntityIds",
        "HOUSEHOLD_INVALID_CONTRACT",
        { childEntityId },
      );
    }
    custodyException = {
      childEntityId,
      fromAt,
      toAt,
      normalCustodianEntityId,
      substituteCustodianEntityId,
      authorityBaselineRelationshipId: normalizeHouseholdIdentifier(
        input.custodyException.authorityBaselineRelationshipId,
        "custody.authorityBaselineRelationshipId",
      ),
      authorityBaselineRevisionSha256:
        input.custodyException.authorityBaselineRevisionSha256 === null ||
        input.custodyException.authorityBaselineRevisionSha256 === undefined
          ? null
          : normalizeHouseholdIdentifier(
              input.custodyException.authorityBaselineRevisionSha256,
              "custody.authorityBaselineRevisionSha256",
            ),
      reason: requireText(input.custodyException.reason, "custody.reason"),
    };
  }
  return {
    summary: requireText(input.summary, "summary"),
    startAt,
    endAt,
    timezone,
    childEntityIds,
    location: input.location?.trim() || null,
    notes: input.notes?.trim() || null,
    custodyException,
  };
}

export function materialScheduleFingerprint(
  terms: HouseholdScheduleTerms,
): string {
  return JSON.stringify({
    startAt: terms.startAt,
    endAt: terms.endAt,
    timezone: terms.timezone,
    childEntityIds: terms.childEntityIds,
    location: terms.location,
    custodyException: terms.custodyException,
  });
}
