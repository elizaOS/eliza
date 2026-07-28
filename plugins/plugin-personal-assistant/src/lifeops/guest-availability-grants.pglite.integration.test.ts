/**
 * Real-PGlite proof that guest-calendar grants resolve through the production
 * knowledge graph and fail closed before exposing provider coordinates.
 */

import { resolveKnowledgeGraphService } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { CALENDAR_GUEST_AVAILABILITY_PURPOSE } from "@elizaos/plugin-calendar";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { buildLifeOpsCalendarGate } from "./calendar-gate.js";
import {
  CALENDAR_GUEST_AVAILABILITY_GRANTS_ATTRIBUTE,
  CALENDAR_GUEST_AVAILABILITY_GRANTS_SCHEMA,
  CALENDAR_GUEST_AVAILABILITY_GRANTS_TAG,
  type StoredCalendarGuestAvailabilityGrant,
} from "./guest-availability-grants.js";

const AUTHORIZATION_AT = "2027-01-15T12:00:00.000Z";
const VALID_GRANT_ID = "gav_7a06c3765be142f58fc0f15d6de58a7d";
const EXPIRED_GRANT_ID = "gav_1f05868be70743598e46fca03c91d201";
const OTHER_PRINCIPAL_GRANT_ID = "gav_034bc8f55aa94381b6c77784531564b7";
const IDENTITY_MISMATCH_GRANT_ID = "gav_2e2e9a4fde9d4d7cbd8845d992db7e5d";

function storedGrant(
  grantId: string,
  overrides: Partial<StoredCalendarGuestAvailabilityGrant> = {},
): StoredCalendarGuestAvailabilityGrant {
  return {
    grantId,
    principalEntityId: SELF_ENTITY_ID,
    provider: "google",
    connectorAccountId: "owner-google-account",
    providerGrantId: "connector-account:owner-google-account",
    calendarId: "guest@example.test",
    purpose: CALENDAR_GUEST_AVAILABILITY_PURPOSE,
    consentRecordedAt: "2027-01-01T12:00:00.000Z",
    expiresAt: "2027-02-01T12:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

describe("guest availability grants — real PGlite knowledge graph", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;

  async function putGuest(input: {
    entityId: string;
    grant: StoredCalendarGuestAvailabilityGrant;
    identityHandle?: string;
  }): Promise<void> {
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    await graph.getEntityStore(runtime.agentId).upsert({
      entityId: input.entityId,
      type: "person",
      preferredName: input.entityId,
      identities: [
        {
          platform: "email",
          handle: input.identityHandle ?? input.grant.calendarId,
          verified: true,
          confidence: 1,
          addedAt: "2027-01-01T12:00:00.000Z",
          addedVia: "user_chat",
          evidence: ["Owner verified the guest calendar identity."],
        },
      ],
      attributes: {
        [CALENDAR_GUEST_AVAILABILITY_GRANTS_ATTRIBUTE]: {
          value: {
            schemaVersion: CALENDAR_GUEST_AVAILABILITY_GRANTS_SCHEMA,
            grants: [input.grant],
          },
          confidence: 1,
          evidence: ["Owner recorded guest free/busy consent."],
          updatedAt: "2027-01-01T12:00:00.000Z",
        },
      },
      tags: [CALENDAR_GUEST_AVAILABILITY_GRANTS_TAG],
      visibility: "owner_only",
      state: {},
    });
  }

  async function resolve(grantId: string, principalEntityId = SELF_ENTITY_ID) {
    return buildLifeOpsCalendarGate(runtime).resolveGuestAvailabilityGrants({
      principalEntityId,
      grantIds: [grantId],
      purpose: CALENDAR_GUEST_AVAILABILITY_PURPOSE,
      at: AUTHORIZATION_AT,
    });
  }

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    const graph = resolveKnowledgeGraphService(runtime);
    if (!graph) throw new Error("knowledge graph unavailable");
    const entities = graph.getEntityStore(runtime.agentId);
    await entities.ensureSelf();
    await entities.upsert({
      entityId: "other-principal",
      type: "person",
      preferredName: "Other principal",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
    });
    await putGuest({
      entityId: "guest-valid",
      grant: storedGrant(VALID_GRANT_ID),
    });
    await putGuest({
      entityId: "guest-expired",
      grant: storedGrant(EXPIRED_GRANT_ID, {
        expiresAt: "2027-01-10T12:00:00.000Z",
      }),
    });
    await putGuest({
      entityId: "guest-other-principal",
      grant: storedGrant(OTHER_PRINCIPAL_GRANT_ID, {
        principalEntityId: "other-principal",
      }),
    });
    await putGuest({
      entityId: "guest-identity-mismatch",
      grant: storedGrant(IDENTITY_MISMATCH_GRANT_ID),
      identityHandle: "different@example.test",
    });
  });

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("resolves an exact purpose-bound, unexpired grant from the guest entity", async () => {
    await expect(resolve(VALID_GRANT_ID)).resolves.toEqual([
      {
        grantId: VALID_GRANT_ID,
        principalEntityId: SELF_ENTITY_ID,
        guestEntityId: "guest-valid",
        provider: "google",
        side: "owner",
        connectorAccountId: "owner-google-account",
        providerGrantId: "connector-account:owner-google-account",
        calendarId: "guest@example.test",
        purpose: CALENDAR_GUEST_AVAILABILITY_PURPOSE,
        consentRecordedAt: "2027-01-01T12:00:00.000Z",
        expiresAt: "2027-02-01T12:00:00.000Z",
      },
    ]);
  });

  it("rejects missing and expired grants", async () => {
    await expect(
      resolve("gav_6849860a6c614420ae0eaa4932559547"),
    ).rejects.toMatchObject({
      code: "CALENDAR_GUEST_AVAILABILITY_GRANT_MISSING",
    });
    await expect(resolve(EXPIRED_GRANT_ID)).rejects.toMatchObject({
      code: "CALENDAR_GUEST_AVAILABILITY_GRANT_EXPIRED",
    });
  });

  it("rejects a grant issued to another principal", async () => {
    await expect(resolve(OTHER_PRINCIPAL_GRANT_ID)).rejects.toMatchObject({
      code: "CALENDAR_GUEST_AVAILABILITY_GRANT_PRINCIPAL_MISMATCH",
    });
  });

  it("rejects a grant whose calendar target lacks a verified guest identity", async () => {
    await expect(resolve(IDENTITY_MISMATCH_GRANT_ID)).rejects.toMatchObject({
      code: "CALENDAR_GUEST_AVAILABILITY_GRANT_INVALID",
    });
  });
});
