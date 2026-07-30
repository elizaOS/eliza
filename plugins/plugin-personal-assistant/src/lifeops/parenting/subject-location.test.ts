/**
 * Deterministic validation coverage for subject-bound location assertions.
 * The pure policy boundary is exercised without replacing graph persistence;
 * real storage and household grants are covered by the PGlite suite.
 */

import type { Entity, EntityAttribute } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  createParentingSubjectLocationAttribute,
  evaluateParentingSubjectLocationEvidence,
  PARENTING_CURRENT_LOCATION_ATTRIBUTE,
} from "./subject-location.js";

const AGENT_ID = "agent-parenting-location";
const SUBJECT_ID = "child-1";
const REQUESTED_AT = "2026-07-27T12:00:00.000Z";

function attribute(
  overrides: Partial<
    Parameters<typeof createParentingSubjectLocationAttribute>[0]
  > = {},
): EntityAttribute {
  return createParentingSubjectLocationAttribute({
    tenantAgentId: AGENT_ID,
    subjectEntityId: SUBJECT_ID,
    locale: "en-US",
    jurisdiction: "US",
    observedAt: "2026-07-27T10:00:00.000Z",
    expiresAt: "2026-07-27T18:00:00.000Z",
    source: "caregiver_presence_confirmation",
    verifiedByEntityId: "self",
    verificationEvidenceId: "presence-check-1",
    ...overrides,
  });
}

function entity(location: EntityAttribute | null = attribute()): Entity {
  return {
    entityId: SUBJECT_ID,
    type: "person",
    preferredName: "Child",
    identities: [],
    ...(location
      ? { attributes: { [PARENTING_CURRENT_LOCATION_ATTRIBUTE]: location } }
      : {}),
    state: {},
    tags: [],
    visibility: "owner_only",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
  };
}

function resolve(
  input: {
    location?: EntityAttribute | null;
    requestedAt?: string;
    verifierAuthorizedForSubject?: boolean;
  } = {},
) {
  return evaluateParentingSubjectLocationEvidence({
    agentId: AGENT_ID,
    subjectEntityId: SUBJECT_ID,
    requestedAt: input.requestedAt ?? REQUESTED_AT,
    entity: entity(
      Object.hasOwn(input, "location") ? (input.location ?? null) : attribute(),
    ),
    verifierAuthorizedForSubject: input.verifierAuthorizedForSubject ?? true,
  });
}

describe("parenting subject location evidence", () => {
  it("accepts a fresh, tenant-bound, subject-bound verified assertion", () => {
    expect(resolve()).toEqual({
      status: "resolved",
      subjectEntityId: SUBJECT_ID,
      locale: "en-US",
      jurisdiction: "US",
      source: "subject_location_graph",
      observedAt: "2026-07-27T10:00:00.000Z",
      expiresAt: "2026-07-27T18:00:00.000Z",
      verificationSource: "caregiver_presence_confirmation",
      verifiedByEntityId: "self",
      verificationEvidenceId: "presence-check-1",
      unavailableReason: null,
    });
  });

  it("distinguishes a missing assertion from malformed or unauthorized evidence", () => {
    expect(resolve({ location: null })).toMatchObject({
      status: "unavailable",
      unavailableReason: "location_missing",
    });
    expect(resolve({ verifierAuthorizedForSubject: false })).toMatchObject({
      status: "unavailable",
      unavailableReason: "location_untrusted",
    });
  });

  it.each([
    {
      label: "another tenant",
      location: attribute({ tenantAgentId: "agent-other" }),
    },
    {
      label: "another child",
      location: attribute({ subjectEntityId: "child-2" }),
    },
    {
      label: "a mismatched jurisdiction",
      location: attribute({ jurisdiction: "GB" }),
    },
    {
      label: "an unsupported assurance value",
      location: {
        ...attribute(),
        value: {
          ...(attribute().value as Record<string, unknown>),
          assurance: "owner_profile_location",
        },
      },
    },
  ])("rejects evidence bound to $label", ({ location }) => {
    expect(resolve({ location })).toMatchObject({
      status: "unavailable",
      unavailableReason: "location_untrusted",
    });
  });

  it("rejects an expired observation without falling back to a home jurisdiction", () => {
    expect(resolve({ requestedAt: "2026-07-28T12:00:00.000Z" })).toMatchObject({
      status: "unavailable",
      locale: "en-US",
      jurisdiction: "US",
      unavailableReason: "location_stale",
    });
  });

  it("treats the expiry instant as unavailable", () => {
    expect(resolve({ requestedAt: "2026-07-27T18:00:00.000Z" })).toMatchObject({
      status: "unavailable",
      unavailableReason: "location_stale",
    });
  });

  it("rejects evidence with a validity window longer than the safety maximum", () => {
    expect(
      resolve({
        location: attribute({
          expiresAt: "2026-07-29T10:00:00.000Z",
        }),
      }),
    ).toMatchObject({
      status: "unavailable",
      unavailableReason: "location_untrusted",
    });
  });
});
