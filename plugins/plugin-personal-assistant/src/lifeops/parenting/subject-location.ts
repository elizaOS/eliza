/**
 * Resolves the current jurisdiction of the child or other parenting subject
 * from a tenant-partitioned graph assertion. The assertion is short-lived and
 * binds its subject, verifier, and evidence identifier so an owner's profile,
 * travel state, planner parameter, or another child's record cannot select
 * safety resources.
 */

import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  type Entity,
  type EntityAttribute,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
  HouseholdCoordinationError,
  type HouseholdCoordinationService,
} from "../household/index.js";

export const PARENTING_CURRENT_LOCATION_ATTRIBUTE =
  "lifeops.parenting.currentLocation" as const;
export const PARENTING_SUBJECT_LOCATION_VERSION = 1 as const;
export const PARENTING_SUBJECT_LOCATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const PARENTING_SUBJECT_LOCATION_SOURCES = [
  "subject_device_location",
  "verified_subject_check_in",
  "caregiver_presence_confirmation",
  "professional_presence_confirmation",
] as const;
export type ParentingSubjectLocationSource =
  (typeof PARENTING_SUBJECT_LOCATION_SOURCES)[number];

export interface ParentingSubjectLocationRecord {
  readonly schemaVersion: typeof PARENTING_SUBJECT_LOCATION_VERSION;
  readonly assurance: "subject_current_location_verified";
  readonly tenantAgentId: string;
  readonly subjectEntityId: string;
  readonly locale: string;
  readonly jurisdiction: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly source: ParentingSubjectLocationSource;
  readonly verifiedByEntityId: string;
  readonly verificationEvidenceId: string;
}

export interface ParentingSubjectLocationAssertion {
  readonly tenantAgentId: string;
  readonly subjectEntityId: string;
  readonly locale: string;
  readonly jurisdiction: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly source: ParentingSubjectLocationSource;
  readonly verifiedByEntityId: string;
  readonly verificationEvidenceId: string;
}

export type ParentingSubjectLocationEvidence =
  | {
      readonly status: "resolved";
      readonly subjectEntityId: string;
      readonly locale: string;
      readonly jurisdiction: string;
      readonly source: "subject_location_graph";
      readonly observedAt: string;
      readonly expiresAt: string;
      readonly verificationSource: ParentingSubjectLocationSource;
      readonly verifiedByEntityId: string;
      readonly verificationEvidenceId: string;
      readonly unavailableReason: null;
    }
  | {
      readonly status: "unavailable";
      readonly subjectEntityId: string;
      readonly locale: string | null;
      readonly jurisdiction: string | null;
      readonly source: "unavailable";
      readonly observedAt: string | null;
      readonly expiresAt: string | null;
      readonly verificationSource: ParentingSubjectLocationSource | null;
      readonly verifiedByEntityId: string | null;
      readonly verificationEvidenceId: string | null;
      readonly unavailableReason:
        | "location_missing"
        | "location_untrusted"
        | "location_stale";
    };

/** Compatibility name for the handoff resource resolver's locale projection. */
export type ParentingLocaleEvidence = ParentingSubjectLocationEvidence;

export interface ParentingSubjectLocationResolver {
  resolve(input: {
    readonly runtime: IAgentRuntime;
    readonly subjectEntityId: string;
    readonly requestedAt: string;
  }): Promise<ParentingSubjectLocationEvidence>;
}

interface ParsedLocale {
  readonly locale: string;
  readonly jurisdiction: string;
}

interface LocationCandidate {
  readonly locale: string | null;
  readonly jurisdiction: string | null;
  readonly observedAt: string | null;
  readonly expiresAt: string | null;
  readonly verificationSource: ParentingSubjectLocationSource | null;
  readonly verifiedByEntityId: string | null;
  readonly verificationEvidenceId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, maximum = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) return null;
  return normalized;
}

function locationSource(value: unknown): ParentingSubjectLocationSource | null {
  if (
    typeof value === "string" &&
    PARENTING_SUBJECT_LOCATION_SOURCES.includes(
      value as ParentingSubjectLocationSource,
    )
  ) {
    return value as ParentingSubjectLocationSource;
  }
  return null;
}

function exactLocale(value: string): ParsedLocale | null {
  try {
    const locale = new Intl.Locale(value);
    if (!locale.region) return null;
    return {
      locale: locale.baseName,
      jurisdiction: locale.region.toUpperCase(),
    };
  } catch {
    // error-policy:J3 malformed persisted locale data becomes an explicit
    // untrusted signal and can never fall through to another jurisdiction.
    return null;
  }
}

function candidateFrom(value: unknown): LocationCandidate {
  if (!isRecord(value)) {
    return {
      locale: null,
      jurisdiction: null,
      observedAt: null,
      expiresAt: null,
      verificationSource: null,
      verifiedByEntityId: null,
      verificationEvidenceId: null,
    };
  }
  return {
    locale: requiredString(value.locale, 100),
    jurisdiction: requiredString(value.jurisdiction, 10),
    observedAt: requiredString(value.observedAt, 100),
    expiresAt: requiredString(value.expiresAt, 100),
    verificationSource: locationSource(value.source),
    verifiedByEntityId: requiredString(value.verifiedByEntityId, 200),
    verificationEvidenceId: requiredString(value.verificationEvidenceId, 500),
  };
}

function unavailable(
  subjectEntityId: string,
  candidate: LocationCandidate,
  unavailableReason:
    | "location_missing"
    | "location_untrusted"
    | "location_stale",
): ParentingSubjectLocationEvidence {
  return {
    status: "unavailable",
    subjectEntityId,
    ...candidate,
    source: "unavailable",
    unavailableReason,
  };
}

function recordFrom(value: unknown): ParentingSubjectLocationRecord | null {
  if (!isRecord(value)) return null;
  const tenantAgentId = requiredString(value.tenantAgentId, 200);
  const subjectEntityId = requiredString(value.subjectEntityId, 200);
  const locale = requiredString(value.locale, 100);
  const jurisdiction = requiredString(value.jurisdiction, 10);
  const observedAt = requiredString(value.observedAt, 100);
  const expiresAt = requiredString(value.expiresAt, 100);
  const source = locationSource(value.source);
  const verifiedByEntityId = requiredString(value.verifiedByEntityId, 200);
  const verificationEvidenceId = requiredString(
    value.verificationEvidenceId,
    500,
  );
  if (
    value.schemaVersion !== PARENTING_SUBJECT_LOCATION_VERSION ||
    value.assurance !== "subject_current_location_verified" ||
    !tenantAgentId ||
    !subjectEntityId ||
    !locale ||
    !jurisdiction ||
    !observedAt ||
    !expiresAt ||
    !source ||
    !verifiedByEntityId ||
    !verificationEvidenceId
  ) {
    return null;
  }
  return {
    schemaVersion: PARENTING_SUBJECT_LOCATION_VERSION,
    assurance: "subject_current_location_verified",
    tenantAgentId,
    subjectEntityId,
    locale,
    jurisdiction,
    observedAt,
    expiresAt,
    source,
    verifiedByEntityId,
    verificationEvidenceId,
  };
}

/**
 * Builds the graph attribute accepted by the production resolver. Callers are
 * trusted host integrations that already authenticated the observation and
 * verifier; the conversational action deliberately exposes no equivalent
 * parameter.
 */
export function createParentingSubjectLocationAttribute(
  assertion: ParentingSubjectLocationAssertion,
  recordedAt: string = assertion.observedAt,
): EntityAttribute {
  return {
    value: {
      schemaVersion: PARENTING_SUBJECT_LOCATION_VERSION,
      assurance: "subject_current_location_verified",
      ...assertion,
    } satisfies ParentingSubjectLocationRecord,
    confidence: 1,
    evidence: [assertion.verificationEvidenceId],
    updatedAt: recordedAt,
  };
}

export function evaluateParentingSubjectLocationEvidence(input: {
  readonly agentId: string;
  readonly subjectEntityId: string;
  readonly requestedAt: string;
  readonly entity: Entity | null;
  readonly verifierAuthorizedForSubject: boolean;
}): ParentingSubjectLocationEvidence {
  const requestedAt = Date.parse(input.requestedAt);
  if (!Number.isFinite(requestedAt)) {
    throw new ElizaError("requestedAt must be an ISO-8601 timestamp", {
      code: "PARENTING_SUBJECT_LOCATION_REQUEST_INVALID",
      context: { requestedAt: input.requestedAt },
      severity: "fatal",
    });
  }
  const attribute =
    input.entity?.attributes?.[PARENTING_CURRENT_LOCATION_ATTRIBUTE];
  if (!attribute) {
    return unavailable(
      input.subjectEntityId,
      candidateFrom(null),
      "location_missing",
    );
  }
  const candidate = candidateFrom(attribute.value);
  const record = recordFrom(attribute.value);
  if (
    !record ||
    attribute.confidence !== 1 ||
    attribute.evidence.length === 0 ||
    !attribute.evidence.includes(record.verificationEvidenceId) ||
    record.tenantAgentId !== input.agentId ||
    record.subjectEntityId !== input.subjectEntityId ||
    input.entity?.entityId !== input.subjectEntityId ||
    !input.verifierAuthorizedForSubject
  ) {
    return unavailable(input.subjectEntityId, candidate, "location_untrusted");
  }
  const parsedLocale = exactLocale(record.locale);
  if (
    !parsedLocale ||
    parsedLocale.jurisdiction !== record.jurisdiction.toUpperCase()
  ) {
    return unavailable(input.subjectEntityId, candidate, "location_untrusted");
  }
  const observedAt = Date.parse(record.observedAt);
  const expiresAt = Date.parse(record.expiresAt);
  const updatedAt = Date.parse(attribute.updatedAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(updatedAt) ||
    updatedAt < observedAt ||
    updatedAt > requestedAt + FUTURE_CLOCK_SKEW_MS ||
    observedAt > requestedAt + FUTURE_CLOCK_SKEW_MS ||
    expiresAt <= observedAt ||
    expiresAt - observedAt > PARENTING_SUBJECT_LOCATION_MAX_AGE_MS
  ) {
    return unavailable(input.subjectEntityId, candidate, "location_untrusted");
  }
  if (
    requestedAt >= expiresAt ||
    requestedAt - observedAt > PARENTING_SUBJECT_LOCATION_MAX_AGE_MS
  ) {
    return unavailable(input.subjectEntityId, candidate, "location_stale");
  }
  return {
    status: "resolved",
    subjectEntityId: input.subjectEntityId,
    locale: parsedLocale.locale,
    jurisdiction: parsedLocale.jurisdiction,
    source: "subject_location_graph",
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    verificationSource: record.source,
    verifiedByEntityId: record.verifiedByEntityId,
    verificationEvidenceId: record.verificationEvidenceId,
    unavailableReason: null,
  };
}

async function verifierAuthorized(input: {
  readonly household: HouseholdCoordinationService;
  readonly subjectEntityId: string;
  readonly verifierEntityId: string | null;
  readonly verificationSource: ParentingSubjectLocationSource | null;
  readonly requestedAt: string;
}): Promise<boolean> {
  if (!input.verifierEntityId || !input.verificationSource) return false;
  if (input.verifierEntityId === SELF_ENTITY_ID) {
    return input.verificationSource === "caregiver_presence_confirmation";
  }
  const bindings = await input.household.listRoleBindings();
  const verifierBinding = bindings.find(
    (binding) => binding.entityId === input.verifierEntityId,
  );
  if (
    verifierBinding?.role === "child" &&
    input.verifierEntityId === input.subjectEntityId &&
    (input.verificationSource === "subject_device_location" ||
      input.verificationSource === "verified_subject_check_in")
  ) {
    return true;
  }
  const sourceMatchesRole =
    input.verificationSource === "caregiver_presence_confirmation"
      ? verifierBinding?.role === "co_parent" ||
        verifierBinding?.role === "current_partner" ||
        verifierBinding?.role === "caregiver"
      : input.verificationSource === "professional_presence_confirmation" &&
        verifierBinding?.role === "professional";
  if (!sourceMatchesRole) return false;
  try {
    await input.household.requireScope({
      principalEntityId: input.verifierEntityId,
      scope: "household.visibility",
      subjectEntityId: input.subjectEntityId,
      at: new Date(input.requestedAt),
    });
    return true;
  } catch (error) {
    // error-policy:J4 an unresolvable verifier or absent, expired, or revoked
    // subject-specific grant makes the assertion unusable; it never degrades
    // to role-only or household-wide authorization.
    if (
      error instanceof HouseholdCoordinationError &&
      (error.code === "HOUSEHOLD_ACCESS_DENIED" ||
        error.code === "HOUSEHOLD_ENTITY_NOT_FOUND" ||
        error.code === "HOUSEHOLD_GRANT_EXPIRED" ||
        error.code === "HOUSEHOLD_GRANT_REVOKED")
    ) {
      return false;
    }
    throw error;
  }
}

export class GraphBackedParentingSubjectLocationResolver
  implements ParentingSubjectLocationResolver
{
  constructor(
    private readonly resolveHousehold: (
      runtime: IAgentRuntime,
    ) => HouseholdCoordinationService = (runtime) =>
      getHouseholdCoordinationService(runtime) ??
      createHouseholdCoordinationService(runtime),
  ) {}

  async resolve(input: {
    readonly runtime: IAgentRuntime;
    readonly subjectEntityId: string;
    readonly requestedAt: string;
  }): Promise<ParentingSubjectLocationEvidence> {
    const graph = resolveKnowledgeGraphService(input.runtime);
    if (!graph) {
      throw new ElizaError(
        "KnowledgeGraphService is required for subject location resolution",
        {
          code: "PARENTING_SUBJECT_LOCATION_GRAPH_UNAVAILABLE",
          context: { agentId: input.runtime.agentId },
          severity: "fatal",
        },
      );
    }
    const entity = await graph
      .getEntityStore(input.runtime.agentId)
      .get(input.subjectEntityId);
    const candidate = candidateFrom(
      entity?.attributes?.[PARENTING_CURRENT_LOCATION_ATTRIBUTE]?.value,
    );
    const authorized = await verifierAuthorized({
      household: this.resolveHousehold(input.runtime),
      subjectEntityId: input.subjectEntityId,
      verifierEntityId: candidate.verifiedByEntityId,
      verificationSource: candidate.verificationSource,
      requestedAt: input.requestedAt,
    });
    return evaluateParentingSubjectLocationEvidence({
      agentId: input.runtime.agentId,
      subjectEntityId: input.subjectEntityId,
      requestedAt: input.requestedAt,
      entity,
      verifierAuthorizedForSubject: authorized,
    });
  }
}

export const graphBackedParentingSubjectLocationResolver =
  new GraphBackedParentingSubjectLocationResolver();
