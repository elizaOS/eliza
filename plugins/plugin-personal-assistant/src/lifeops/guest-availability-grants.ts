/**
 * Resolves opaque guest-availability grants from the runtime knowledge graph.
 *
 * Grant records live on the guest entity they authorize, so identity merges
 * retain the consent binding. Only this host-side resolver turns a grant id
 * into provider/account/calendar coordinates; action parameters never do.
 */

import { resolveKnowledgeGraphService } from "@elizaos/agent";
import type { IAgentRuntime } from "@elizaos/core";
import {
  CALENDAR_GUEST_AVAILABILITY_PURPOSE,
  type CalendarGuestAvailabilityGrant,
  type CalendarGuestAvailabilityGrantRequest,
  type CalendarGuestAvailabilityProvider,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import type { Entity, EntityAttribute, EntityIdentity } from "@elizaos/shared";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import {
  createHouseholdCoordinationService,
  getHouseholdCoordinationService,
} from "./household/service.js";

export const CALENDAR_GUEST_AVAILABILITY_GRANTS_ATTRIBUTE =
  "calendar.guest_availability_grants.v1";
export const CALENDAR_GUEST_AVAILABILITY_GRANTS_TAG =
  "calendar-guest-availability";
export const CALENDAR_GUEST_AVAILABILITY_GRANTS_SCHEMA =
  "calendar.guest-availability-grants.v1";

export interface StoredCalendarGuestAvailabilityGrant {
  grantId: string;
  principalEntityId: string;
  provider: CalendarGuestAvailabilityProvider;
  connectorAccountId: string;
  providerGrantId: string;
  calendarId: string;
  purpose: typeof CALENDAR_GUEST_AVAILABILITY_PURPOSE;
  consentRecordedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface StoredCalendarGuestAvailabilityGrantEnvelope {
  schemaVersion: typeof CALENDAR_GUEST_AVAILABILITY_GRANTS_SCHEMA;
  grants: StoredCalendarGuestAvailabilityGrant[];
}

function authorizationError(
  message: string,
  code:
    | "CALENDAR_GUEST_AVAILABILITY_GRAPH_UNAVAILABLE"
    | "CALENDAR_GUEST_AVAILABILITY_GRANT_EXPIRED"
    | "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID"
    | "CALENDAR_GUEST_AVAILABILITY_GRANT_MISSING"
    | "CALENDAR_GUEST_AVAILABILITY_GRANT_PRINCIPAL_MISMATCH"
    | "CALENDAR_GUEST_AVAILABILITY_GRANT_REVOKED",
): CalendarServiceError {
  return new CalendarServiceError(
    code === "CALENDAR_GUEST_AVAILABILITY_GRAPH_UNAVAILABLE" ? 503 : 403,
    message,
    code,
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw authorizationError(
      `Guest availability authorization has an invalid ${field}.`,
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  return value.trim();
}

function requiredInstant(value: unknown, field: string): string {
  const instant = requiredString(value, field);
  if (!Number.isFinite(Date.parse(instant))) {
    throw authorizationError(
      `Guest availability authorization has an invalid ${field}.`,
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  return instant;
}

function provider(value: unknown): CalendarGuestAvailabilityProvider {
  if (value !== "google" && value !== "microsoft") {
    throw authorizationError(
      "Guest availability authorization has an invalid provider.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  return value;
}

function purpose(value: unknown): typeof CALENDAR_GUEST_AVAILABILITY_PURPOSE {
  if (value !== CALENDAR_GUEST_AVAILABILITY_PURPOSE) {
    throw authorizationError(
      "Guest availability authorization has an invalid purpose.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  return value;
}

function parseStoredGrant(
  value: unknown,
): StoredCalendarGuestAvailabilityGrant {
  const record = recordValue(value);
  if (!record) {
    throw authorizationError(
      "Guest availability authorization is malformed.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  const revokedAt =
    record.revokedAt === null
      ? null
      : requiredInstant(record.revokedAt, "revokedAt");
  return {
    grantId: requiredString(record.grantId, "grantId"),
    principalEntityId: requiredString(
      record.principalEntityId,
      "principalEntityId",
    ),
    provider: provider(record.provider),
    connectorAccountId: requiredString(
      record.connectorAccountId,
      "connectorAccountId",
    ),
    providerGrantId: requiredString(record.providerGrantId, "providerGrantId"),
    calendarId: requiredString(record.calendarId, "calendarId"),
    purpose: purpose(record.purpose),
    consentRecordedAt: requiredInstant(
      record.consentRecordedAt,
      "consentRecordedAt",
    ),
    expiresAt: requiredInstant(record.expiresAt, "expiresAt"),
    revokedAt,
  };
}

function grantsFromAttribute(
  attribute: EntityAttribute,
): StoredCalendarGuestAvailabilityGrant[] {
  if (
    attribute.confidence !== 1 ||
    attribute.evidence.length === 0 ||
    !Number.isFinite(Date.parse(attribute.updatedAt))
  ) {
    throw authorizationError(
      "Guest availability authorization lacks owner-confirmed provenance.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  const envelope = recordValue(attribute.value);
  if (
    !envelope ||
    envelope.schemaVersion !== CALENDAR_GUEST_AVAILABILITY_GRANTS_SCHEMA ||
    !Array.isArray(envelope.grants)
  ) {
    throw authorizationError(
      "Guest availability authorization uses an unsupported contract.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  return envelope.grants.map(parseStoredGrant);
}

function identityMatchesGrant(
  identities: readonly EntityIdentity[],
  grant: StoredCalendarGuestAvailabilityGrant,
): boolean {
  const acceptedPlatforms = new Set([
    "email",
    grant.provider,
    `${grant.provider}_calendar`,
    `${grant.provider}.calendar`,
  ]);
  const calendarId = grant.calendarId.toLowerCase();
  return identities.some(
    (identity) =>
      identity.verified &&
      acceptedPlatforms.has(identity.platform.toLowerCase()) &&
      identity.handle.trim().toLowerCase() === calendarId,
  );
}

async function requirePrincipalScope(input: {
  runtime: IAgentRuntime;
  principalEntityId: string;
  guestEntityId: string;
  at: Date;
}): Promise<void> {
  if (input.principalEntityId === SELF_ENTITY_ID) return;
  const household =
    getHouseholdCoordinationService(input.runtime) ??
    createHouseholdCoordinationService(input.runtime);
  await household.requireScope({
    principalEntityId: input.principalEntityId,
    subjectEntityId: input.guestEntityId,
    scope: "calendar.freebusy",
    at: input.at,
  });
}

function validateRequestedGrant(input: {
  stored: StoredCalendarGuestAvailabilityGrant;
  guest: Entity;
  request: CalendarGuestAvailabilityGrantRequest;
  at: Date;
}): CalendarGuestAvailabilityGrant {
  const { stored, guest, request, at } = input;
  if (stored.principalEntityId !== request.principalEntityId) {
    throw authorizationError(
      "Guest availability authorization belongs to another principal.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_PRINCIPAL_MISMATCH",
    );
  }
  if (stored.purpose !== request.purpose) {
    throw authorizationError(
      "Guest availability authorization is not valid for this purpose.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  if (stored.revokedAt !== null) {
    throw authorizationError(
      "Guest availability authorization has been revoked.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_REVOKED",
    );
  }
  if (Date.parse(stored.expiresAt) <= at.getTime()) {
    throw authorizationError(
      "Guest availability authorization has expired.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_EXPIRED",
    );
  }
  if (Date.parse(stored.consentRecordedAt) > at.getTime()) {
    throw authorizationError(
      "Guest availability authorization has invalid consent timing.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  if (!identityMatchesGrant(guest.identities, stored)) {
    throw authorizationError(
      "Guest availability authorization does not match a verified guest identity.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    );
  }
  return {
    grantId: stored.grantId,
    principalEntityId: stored.principalEntityId,
    guestEntityId: guest.entityId,
    provider: stored.provider,
    side: "owner",
    connectorAccountId: stored.connectorAccountId,
    providerGrantId: stored.providerGrantId,
    calendarId: stored.calendarId,
    purpose: stored.purpose,
    consentRecordedAt: stored.consentRecordedAt,
    expiresAt: stored.expiresAt,
  };
}

/**
 * Resolve all requested grants atomically. Any missing, duplicate, expired,
 * revoked, cross-principal, or identity-mismatched record rejects the whole
 * request before a calendar provider can be contacted.
 */
export async function resolveCalendarGuestAvailabilityGrants(
  runtime: IAgentRuntime,
  request: CalendarGuestAvailabilityGrantRequest,
): Promise<readonly CalendarGuestAvailabilityGrant[]> {
  const principalEntityId = requiredString(
    request.principalEntityId,
    "principalEntityId",
  );
  const atIso = requiredInstant(request.at, "at");
  const at = new Date(atIso);
  const requestedGrantIds = Array.from(
    new Set(
      request.grantIds.map((grantId) => requiredString(grantId, "grantId")),
    ),
  );
  if (requestedGrantIds.length === 0) {
    throw authorizationError(
      "Guest availability authorization is required.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_MISSING",
    );
  }
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) {
    throw authorizationError(
      "Guest availability authorization is unavailable.",
      "CALENDAR_GUEST_AVAILABILITY_GRAPH_UNAVAILABLE",
    );
  }
  const entityStore = graph.getEntityStore(runtime.agentId);
  if (!(await entityStore.get(principalEntityId))) {
    throw authorizationError(
      "Guest availability principal is unavailable.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_PRINCIPAL_MISMATCH",
    );
  }
  const guests = await entityStore.list({
    tag: CALENDAR_GUEST_AVAILABILITY_GRANTS_TAG,
  });
  const requested = new Set(requestedGrantIds);
  const matches = new Map<
    string,
    { stored: StoredCalendarGuestAvailabilityGrant; guest: Entity }
  >();
  for (const guest of guests) {
    const attribute =
      guest.attributes?.[CALENDAR_GUEST_AVAILABILITY_GRANTS_ATTRIBUTE];
    if (!attribute) continue;
    for (const stored of grantsFromAttribute(attribute)) {
      if (!requested.has(stored.grantId)) continue;
      if (matches.has(stored.grantId)) {
        throw authorizationError(
          "Guest availability authorization is ambiguous.",
          "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
        );
      }
      matches.set(stored.grantId, { stored, guest });
    }
  }
  if (
    matches.size !== requestedGrantIds.length ||
    requestedGrantIds.some((grantId) => !matches.has(grantId))
  ) {
    throw authorizationError(
      "Guest availability authorization is missing.",
      "CALENDAR_GUEST_AVAILABILITY_GRANT_MISSING",
    );
  }

  const resolved: CalendarGuestAvailabilityGrant[] = [];
  for (const grantId of requestedGrantIds) {
    const match = matches.get(grantId);
    if (!match) {
      throw authorizationError(
        "Guest availability authorization is missing.",
        "CALENDAR_GUEST_AVAILABILITY_GRANT_MISSING",
      );
    }
    const grant = validateRequestedGrant({
      ...match,
      request: { ...request, principalEntityId },
      at,
    });
    await requirePrincipalScope({
      runtime,
      principalEntityId,
      guestEntityId: grant.guestEntityId,
      at,
    });
    resolved.push(grant);
  }
  return resolved;
}
