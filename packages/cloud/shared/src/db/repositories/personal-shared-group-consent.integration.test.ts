/** Focused multi-principal consent authority tests on isolated PGlite. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { asc, eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import {
  personalSharedGroupBindings,
  personalSharedGroupClaims,
  personalSharedGroupDeliveryAttempts,
  personalSharedGroupDeliveryReceipts,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../schemas/personal-shared-groups";
import { users } from "../schemas/users";
import { personalSharedGroupConsentRepository } from "./personal-shared-group-consent";
import { personalSharedGroupParticipantsRepository } from "./personal-shared-group-participants";
import { personalSharedGroupsRepository } from "./personal-shared-groups";
import { usersRepository } from "./users";

const OWNER_ORG = "76000000-0000-4000-8000-000000000001";
const JOINER_ORG = "76000000-0000-4000-8000-000000000002";
const OWNER_USER = "76000000-0000-4000-8000-000000000011";
const JOINER_USER = "76000000-0000-4000-8000-000000000012";
const ADDITIONAL_NON_OWNER_USER = "76000000-0000-4000-8000-000000000013";
const OWNER_HANDLE = "+15550100001";
const JOINER_HANDLE = "+15550100002";
const CHILD_HANDLE = "+15550100003";
const ADDITIONAL_NON_OWNER_HANDLE = "+15550100004";
const CONNECTOR = "blooio:+15550100999";
const CHAT = "synthetic-family-group";
const AUTH_HASH = "a".repeat(64);
const CONFIRM_HASH = "b".repeat(64);
const PGLITE_TIMEOUT_MS = 60_000;
let ownerClaimSequence = 0;
let deliverySequence = 0;

async function settleWithin<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function seedAccounts(): Promise<void> {
  await dbWrite.insert(organizations).values([
    { id: OWNER_ORG, name: "Parent A", slug: "consent-parent-a" },
    { id: JOINER_ORG, name: "Parent B", slug: "consent-parent-b" },
  ]);
  await dbWrite.insert(users).values([
    {
      id: OWNER_USER,
      organization_id: OWNER_ORG,
      steward_user_id: "steward-parent-a",
      phone_number: OWNER_HANDLE,
      phone_verified: true,
      role: "owner",
    },
    {
      id: JOINER_USER,
      organization_id: JOINER_ORG,
      // A provider-attested first contact is not independently authenticated.
      steward_user_id: `phone:${JOINER_HANDLE}`,
      phone_number: JOINER_HANDLE,
      phone_verified: true,
      role: "owner",
    },
  ]);
}

async function bind(input?: {
  consentMode?: "single_owner" | "all_adults";
  requiredPrincipalCount?: number;
  chatId?: string;
}) {
  const chatId = input?.chatId ?? CHAT;
  const codeHash = `owner-claim-${chatId}-${++ownerClaimSequence}`;
  await personalSharedGroupsRepository.issueClaim({
    codeHash,
    organizationId: OWNER_ORG,
    ownerUserId: OWNER_USER,
    personalAgentId: "personal:parent-a",
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR,
    issuedToPlatformUserId: OWNER_HANDLE,
    consentMode: input?.consentMode,
    requiredPrincipalCount: input?.requiredPrincipalCount,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const result = await personalSharedGroupsRepository.consumeClaimAndBind({
    codeHash,
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR,
    providerChatId: chatId,
    actorPlatformUserId: OWNER_HANDLE,
  });
  if (result.status !== "bound") throw new Error(`binding failed: ${result.status}`);
  return result.binding;
}

async function register(bindingId: string, platformUserId: string): Promise<void> {
  await personalSharedGroupParticipantsRepository.recordTurn({ bindingId, platformUserId });
}

async function issueAuthenticate(
  bindingId: string,
  codeHash = AUTH_HASH,
  options?: {
    actorPlatformUserId?: string;
    sourceMessageId?: string;
    expiresAt?: Date;
  },
) {
  return personalSharedGroupConsentRepository.issueJoinAuthenticateChallenge({
    codeHash,
    ...(options?.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
    bindingId,
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR,
    providerChatId: CHAT,
    providerThreadId: null,
    actorPlatformUserId: options?.actorPlatformUserId ?? JOINER_HANDLE,
    expiresAt: options?.expiresAt ?? new Date(Date.now() + 60_000),
  });
}

function deliveryFor(
  binding: Awaited<ReturnType<typeof bind>>,
  requiresAllAdultsConsent?: boolean,
) {
  const sequence = ++deliverySequence;
  return {
    authority: {
      bindingId: binding.id,
      ownerUserId: binding.owner_user_id,
      personalAgentId: binding.personal_agent_id,
      version: binding.authority_version,
      ...(requiresAllAdultsConsent === undefined ? {} : { requiresAllAdultsConsent }),
    },
    platform: "blooio" as const,
    project: "eliza-app",
    connectorAccountId: CONNECTOR,
    providerChatId: CHAT,
    invocation: "mention" as const,
    sourceMessageId: `consent-egress-${sequence}`,
    leaseToken: `76000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
  };
}

async function bindWithEligibleJoiner() {
  const binding = await bind({
    consentMode: "all_adults",
    requiredPrincipalCount: 2,
  });
  await register(binding.id, JOINER_HANDLE);
  await issueAuthenticate(binding.id);
  await dbWrite
    .update(users)
    .set({ steward_user_id: "steward-parent-b" })
    .where(eq(users.id, JOINER_USER));
  const authenticated = await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge(
    {
      codeHash: AUTH_HASH,
      confirmCodeHash: CONFIRM_HASH,
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      actorPlatformUserId: JOINER_HANDLE,
      linkedUserId: JOINER_USER,
      linkedOrganizationId: JOINER_ORG,
      expiresAt: new Date(Date.now() + 60_000),
    },
  );
  if (authenticated.status !== "confirm_issued") {
    throw new Error(`join authentication failed: ${authenticated.status}`);
  }
  const confirmed = await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
    codeHash: CONFIRM_HASH,
    bindingId: binding.id,
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR,
    providerChatId: CHAT,
    providerThreadId: null,
    actorPlatformUserId: JOINER_HANDLE,
  });
  if (confirmed.status !== "consented") {
    throw new Error(`join confirmation failed: ${confirmed.status}`);
  }
  const current = await personalSharedGroupsRepository.findBindingById(binding.id);
  if (!current) throw new Error("eligible binding vanished");
  return current;
}

beforeAll(async () => {
  const { apply } = await pushSchema(
    {
      organizationBalanceRevisionSequence,
      organizations,
      users,
      personalSharedGroupClaims,
      personalSharedGroupBindings,
      personalSharedGroupParticipants,
      personalSharedGroupJoinChallenges,
      personalSharedGroupDeliveryReceipts,
      personalSharedGroupDeliveryAttempts,
    } as never,
    dbWrite as never,
  );
  await apply();
}, PGLITE_TIMEOUT_MS);

beforeEach(async () => {
  // Fail-closed participant links deliberately prevent user deletion. Remove
  // the binding authority first so its cascading roster cleanup releases the
  // account rows between isolated cases.
  await dbWrite.delete(personalSharedGroupBindings);
  await dbWrite.delete(organizations);
  await seedAccounts();
}, PGLITE_TIMEOUT_MS);

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
}, PGLITE_TIMEOUT_MS);

describe("PersonalSharedGroupConsentRepository", () => {
  test("requires a mature owner at all-adults issue and consume without burning the claim", async () => {
    await dbWrite
      .update(users)
      .set({ steward_user_id: `phone:${OWNER_HANDLE}` })
      .where(eq(users.id, OWNER_USER));
    await expect(
      personalSharedGroupsRepository.issueClaim({
        codeHash: "provisional-owner-cannot-issue",
        organizationId: OWNER_ORG,
        ownerUserId: OWNER_USER,
        personalAgentId: "personal:parent-a",
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        issuedToPlatformUserId: OWNER_HANDLE,
        consentMode: "all_adults",
        requiredPrincipalCount: 2,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
    });
    expect(
      await dbWrite.select({ id: personalSharedGroupClaims.id }).from(personalSharedGroupClaims),
    ).toHaveLength(0);

    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-a" })
      .where(eq(users.id, OWNER_USER));
    const codeHash = "mature-owner-downgraded-before-bind";
    await personalSharedGroupsRepository.issueClaim({
      codeHash,
      organizationId: OWNER_ORG,
      ownerUserId: OWNER_USER,
      personalAgentId: "personal:parent-a",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      issuedToPlatformUserId: OWNER_HANDLE,
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await dbWrite
      .update(users)
      .set({ steward_user_id: `phone:${OWNER_HANDLE}` })
      .where(eq(users.id, OWNER_USER));
    const consume = () =>
      personalSharedGroupsRepository.consumeClaimAndBind({
        codeHash,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        actorPlatformUserId: OWNER_HANDLE,
      });
    await expect(consume()).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
    });
    expect(
      await dbWrite
        .select({ consumedAt: personalSharedGroupClaims.consumed_at })
        .from(personalSharedGroupClaims)
        .where(eq(personalSharedGroupClaims.code_hash, codeHash)),
    ).toEqual([{ consumedAt: null }]);

    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-a" })
      .where(eq(users.id, OWNER_USER));
    expect((await consume()).status).toBe("bound");
  });

  test("requires an active owner organization at all-adults issue and consume", async () => {
    const issue = (codeHash: string) =>
      personalSharedGroupsRepository.issueClaim({
        codeHash,
        organizationId: OWNER_ORG,
        ownerUserId: OWNER_USER,
        personalAgentId: "personal:parent-a",
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        issuedToPlatformUserId: OWNER_HANDLE,
        consentMode: "all_adults",
        requiredPrincipalCount: 2,
        expiresAt: new Date(Date.now() + 60_000),
      });
    await dbWrite
      .update(organizations)
      .set({ is_active: false })
      .where(eq(organizations.id, OWNER_ORG));
    await expect(issue("inactive-owner-org-issue")).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
    });
    expect(
      await dbWrite.select({ id: personalSharedGroupClaims.id }).from(personalSharedGroupClaims),
    ).toHaveLength(0);

    await dbWrite
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, OWNER_ORG));
    const codeHash = "inactive-owner-org-consume";
    await issue(codeHash);
    await dbWrite
      .update(organizations)
      .set({ is_active: false })
      .where(eq(organizations.id, OWNER_ORG));
    const consume = () =>
      personalSharedGroupsRepository.consumeClaimAndBind({
        codeHash,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        actorPlatformUserId: OWNER_HANDLE,
      });
    await expect(consume()).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
    });
    expect(
      await dbWrite
        .select({ consumedAt: personalSharedGroupClaims.consumed_at })
        .from(personalSharedGroupClaims)
        .where(eq(personalSharedGroupClaims.code_hash, codeHash)),
    ).toEqual([{ consumedAt: null }]);

    await dbWrite
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, OWNER_ORG));
    expect((await consume()).status).toBe("bound");
  });

  test("preserves the empty and existing roster on the default single-owner path", async () => {
    // Legacy provider-created personal accounts remain allowed in the default
    // mode; the stronger maturity boundary is all-adults-only.
    await dbWrite
      .update(users)
      .set({ steward_user_id: `phone:${OWNER_HANDLE}` })
      .where(eq(users.id, OWNER_USER));
    const binding = await bind();
    expect(binding).toMatchObject({
      consent_mode: "single_owner",
      required_principal_count: 1,
    });
    expect(
      await dbWrite
        .select({ id: personalSharedGroupParticipants.id })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, binding.id)),
    ).toHaveLength(0);

    await register(binding.id, OWNER_HANDLE);
    await register(binding.id, CHILD_HANDLE);
    const rosterBefore = await dbWrite
      .select({
        platformUserId: personalSharedGroupParticipants.platform_user_id,
        ordinal: personalSharedGroupParticipants.ordinal,
        linkedUserId: personalSharedGroupParticipants.linked_user_id,
        consentedAt: personalSharedGroupParticipants.consented_at,
        revokedAt: personalSharedGroupParticipants.revoked_at,
      })
      .from(personalSharedGroupParticipants)
      .where(eq(personalSharedGroupParticipants.binding_id, binding.id))
      .orderBy(asc(personalSharedGroupParticipants.ordinal));
    const rebound = await bind();
    expect(rebound.id).toBe(binding.id);
    expect(
      await dbWrite
        .select({
          platformUserId: personalSharedGroupParticipants.platform_user_id,
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, binding.id))
        .orderBy(asc(personalSharedGroupParticipants.ordinal)),
    ).toEqual(rosterBefore);
    expect(
      await personalSharedGroupsRepository.revokeBinding({
        bindingId: binding.id,
        ownerUserId: OWNER_USER,
      }),
    ).toBe(true);
    expect(
      await dbWrite
        .select({ revokedAt: personalSharedGroupParticipants.revoked_at })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, binding.id)),
    ).toEqual([{ revokedAt: null }, { revokedAt: null }]);
  });

  test("creates owner consent, admits the authenticated joiner, and ignores Child C for gating", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    expect(binding).toMatchObject({
      consent_mode: "all_adults",
      required_principal_count: 2,
      consent_version: 1,
    });
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({
        bindingId: binding.id,
      }),
    ).toMatchObject({
      gate: "restricted",
      registeredParticipantCount: 1,
      linkedParticipantCount: 1,
      consentedParticipantCount: 1,
      participants: [{ ordinal: 1, isOwner: true, linked: true, consented: true, revoked: false }],
    });

    await register(binding.id, JOINER_HANDLE);
    await register(binding.id, CHILD_HANDLE);
    expect(await issueAuthenticate(binding.id)).toEqual({
      status: "issued",
      consentVersion: 1,
    });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ status: "account_not_authenticated" });

    // A real sign-in promotes the same durable user away from phone:<E.164>.
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: "+15550109999",
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ status: "wrong_sender" });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ status: "confirm_issued", bindingId: binding.id, consentVersion: 1 });

    expect(
      await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: CONFIRM_HASH,
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: "forged-sub-thread",
        actorPlatformUserId: JOINER_HANDLE,
      }),
    ).toEqual({ status: "wrong_scope" });
    const joined = await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
      codeHash: CONFIRM_HASH,
      bindingId: binding.id,
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      providerChatId: CHAT,
      providerThreadId: null,
      actorPlatformUserId: JOINER_HANDLE,
    });
    expect(joined.status).toBe("consented");
    if (joined.status !== "consented") throw new Error("expected completed consent");
    expect(joined.consent).toMatchObject({
      gate: "enabled",
      requiredPrincipalCount: 2,
      registeredParticipantCount: 3,
      linkedParticipantCount: 2,
      consentedParticipantCount: 2,
    });
    expect(joined.consent.participants[2]).toEqual({
      ordinal: 3,
      isOwner: false,
      linked: false,
      consented: false,
      revoked: false,
    });
    const serialized = JSON.stringify(joined.consent);
    expect(serialized).not.toContain(OWNER_HANDLE);
    expect(serialized).not.toContain(JOINER_HANDLE);
    expect(serialized).not.toContain(CHILD_HANDLE);
    expect(serialized).not.toContain(OWNER_USER);
    expect(serialized).not.toContain(JOINER_USER);
  });

  test("requires an active participant organization at both join stages", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    await dbWrite
      .update(organizations)
      .set({ is_active: false })
      .where(eq(organizations.id, JOINER_ORG));

    const authenticate = () =>
      personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      });
    expect(await authenticate()).toEqual({ status: "account_not_authenticated" });

    await dbWrite
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, JOINER_ORG));
    expect(await authenticate()).toMatchObject({
      status: "confirm_issued",
      bindingId: binding.id,
    });
    await dbWrite
      .update(organizations)
      .set({ is_active: false })
      .where(eq(organizations.id, JOINER_ORG));
    const confirm = () =>
      personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: CONFIRM_HASH,
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: JOINER_HANDLE,
      });
    expect(await confirm()).toEqual({ status: "account_not_authenticated" });

    await dbWrite
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, JOINER_ORG));
    expect(await confirm()).toMatchObject({ status: "consented" });
  });

  test("retains tombstones past gateway dedupe and rejects the old source after reissue", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    const supersededHash = "e".repeat(64);
    const currentHash = "f".repeat(64);
    expect(
      await issueAuthenticate(binding.id, supersededHash, {
        sourceMessageId: "parent-b-source-1",
      }),
    ).toMatchObject({
      status: "issued",
    });
    // Simulate delivery after the gateway's finite webhook-dedupe horizon.
    // The security boundary is the durable source tombstone, not Redis TTL.
    await dbWrite
      .update(personalSharedGroupJoinChallenges)
      .set({ created_at: new Date(Date.now() - 32 * 24 * 60 * 60_000) })
      .where(eq(personalSharedGroupJoinChallenges.code_hash, supersededHash));
    expect(
      await issueAuthenticate(binding.id, currentHash, {
        sourceMessageId: "parent-b-source-2",
      }),
    ).toMatchObject({
      status: "issued",
    });
    expect(
      await issueAuthenticate(binding.id, supersededHash, {
        sourceMessageId: "parent-b-source-1",
      }),
    ).toEqual({ status: "already_used" });

    expect(
      await dbWrite
        .select({
          codeHash: personalSharedGroupJoinChallenges.code_hash,
          stage: personalSharedGroupJoinChallenges.stage,
          consumedAt: personalSharedGroupJoinChallenges.consumed_at,
          supersededAt: personalSharedGroupJoinChallenges.superseded_at,
          supersededBy: personalSharedGroupJoinChallenges.superseded_by_source_message_id,
        })
        .from(personalSharedGroupJoinChallenges)
        .where(eq(personalSharedGroupJoinChallenges.binding_id, binding.id))
        .orderBy(asc(personalSharedGroupJoinChallenges.code_hash)),
    ).toEqual([
      {
        codeHash: supersededHash,
        stage: "authenticate",
        consumedAt: expect.any(Date),
        supersededAt: expect.any(Date),
        supersededBy: "parent-b-source-2",
      },
      {
        codeHash: currentHash,
        stage: "authenticate",
        consumedAt: null,
        supersededAt: null,
        supersededBy: null,
      },
    ]);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: supersededHash,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ status: "already_used" });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: currentHash,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ status: "confirm_issued", bindingId: binding.id });
  });

  test("keeps source replays stable across another actor's issuance and completed consent", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await register(binding.id, CHILD_HANDLE);
    expect(
      await issueAuthenticate(binding.id, AUTH_HASH, {
        sourceMessageId: "group-source-parent-b",
      }),
    ).toMatchObject({ status: "issued" });
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));

    const authenticate = () =>
      personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        sourceMessageId: "dm-source-parent-b",
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      });
    expect(await authenticate()).toMatchObject({
      status: "confirm_issued",
      bindingId: binding.id,
    });
    const [confirmBeforeReplay] = await dbWrite
      .select({
        id: personalSharedGroupJoinChallenges.id,
        expiresAt: personalSharedGroupJoinChallenges.expires_at,
      })
      .from(personalSharedGroupJoinChallenges)
      .where(eq(personalSharedGroupJoinChallenges.code_hash, CONFIRM_HASH));

    // A different participant asking to join must not sweep Parent B's
    // consumed authenticate row, because that row is the durable replay key
    // for a provider delivery whose response may have been lost.
    expect(
      await issueAuthenticate(binding.id, "c".repeat(64), {
        actorPlatformUserId: CHILD_HANDLE,
        sourceMessageId: "group-source-child-c",
      }),
    ).toMatchObject({ status: "issued" });
    expect(await authenticate()).toMatchObject({
      status: "confirm_issued",
      bindingId: binding.id,
    });

    // A late replay of the original group delivery keeps the displayed code
    // and the already-issued confirmation intact.
    expect(
      await issueAuthenticate(binding.id, AUTH_HASH, {
        sourceMessageId: "group-source-parent-b",
      }),
    ).toMatchObject({ status: "issued" });
    const [confirmAfterReplay] = await dbWrite
      .select({
        id: personalSharedGroupJoinChallenges.id,
        expiresAt: personalSharedGroupJoinChallenges.expires_at,
      })
      .from(personalSharedGroupJoinChallenges)
      .where(eq(personalSharedGroupJoinChallenges.code_hash, CONFIRM_HASH));
    expect(confirmAfterReplay).toEqual(confirmBeforeReplay);

    const confirm = () =>
      personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: CONFIRM_HASH,
        sourceMessageId: "group-confirm-source-parent-b",
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: JOINER_HANDLE,
      });
    expect(await confirm()).toMatchObject({ status: "consented" });
    expect(await confirm()).toMatchObject({ status: "consented" });
  });

  test("rejoins cleanly after a non-owner self-revokes", async () => {
    const binding = await bindWithEligibleJoiner();
    expect(
      await personalSharedGroupConsentRepository.selfRevoke({
        bindingId: binding.id,
        actorPlatformUserId: JOINER_HANDLE,
      }),
    ).toMatchObject({ status: "revoked", consent: { gate: "restricted" } });

    const nextAuthenticateHash = "d".repeat(64);
    const nextConfirmHash = "e".repeat(64);
    expect(
      await issueAuthenticate(binding.id, nextAuthenticateHash, {
        sourceMessageId: "group-source-parent-b-rejoin",
      }),
    ).toMatchObject({ status: "issued" });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: nextAuthenticateHash,
        confirmCodeHash: nextConfirmHash,
        sourceMessageId: "dm-source-parent-b-rejoin",
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ status: "confirm_issued" });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: nextConfirmHash,
        sourceMessageId: "group-confirm-source-parent-b-rejoin",
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: JOINER_HANDLE,
      }),
    ).toMatchObject({ status: "consented", consent: { gate: "enabled" } });
  });

  test("preserves eligible consent on rejected identity links and revokes it on a real change", async () => {
    const binding = await bindWithEligibleJoiner();
    expect(
      await dbWrite.transaction((tx) =>
        usersRepository.linkMessagingIdentityInTransaction(
          tx,
          JOINER_USER,
          "phone",
          "+15550109999",
        ),
      ),
    ).toEqual({ status: "handle_conflict" });
    expect(
      await usersRepository.linkTelegramAndPhoneIdentity(JOINER_USER, {
        telegram_id: "200000000002",
        phone_number: "+15550109999",
      }),
    ).toEqual({ status: "phone_mismatch", existingPhone: JOINER_HANDLE });
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "enabled", consentedParticipantCount: 2 });

    expect(
      await usersRepository.linkStewardId(JOINER_USER, "steward-parent-b-rotated"),
    ).toBeDefined();
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
    expect(await usersRepository.linkStewardId(JOINER_USER, "steward-parent-b")).toBeDefined();
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
  });

  test("self-revokes only a linked non-owner and invalidates the consent epoch", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
      codeHash: AUTH_HASH,
      confirmCodeHash: CONFIRM_HASH,
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      actorPlatformUserId: JOINER_HANDLE,
      linkedUserId: JOINER_USER,
      linkedOrganizationId: JOINER_ORG,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (
        await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
          codeHash: CONFIRM_HASH,
          bindingId: binding.id,
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: CONNECTOR,
          providerChatId: CHAT,
          providerThreadId: null,
          actorPlatformUserId: JOINER_HANDLE,
        })
      ).status,
    ).toBe("consented");
    expect(
      await personalSharedGroupConsentRepository.selfRevoke({
        bindingId: binding.id,
        actorPlatformUserId: OWNER_HANDLE,
      }),
    ).toEqual({ status: "owner_forbidden" });
    const revoked = await personalSharedGroupConsentRepository.selfRevoke({
      bindingId: binding.id,
      actorPlatformUserId: JOINER_HANDLE,
    });
    expect(revoked.status).toBe("revoked");
    if (revoked.status !== "revoked") throw new Error("expected self-revocation");
    expect(revoked.consent).toMatchObject({
      gate: "restricted",
      registeredParticipantCount: 1,
      consentedParticipantCount: 1,
    });
    expect(await personalSharedGroupsRepository.findBindingById(binding.id)).toMatchObject({
      state: "active",
      authority_version: binding.authority_version + 2,
      consent_version: binding.consent_version + 1,
    });
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);
  });

  test("restricts soft-deleted consent and blocks hard deletion while its authority link is live", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
      codeHash: AUTH_HASH,
      confirmCodeHash: CONFIRM_HASH,
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      actorPlatformUserId: JOINER_HANDLE,
      linkedUserId: JOINER_USER,
      linkedOrganizationId: JOINER_ORG,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (
        await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
          codeHash: CONFIRM_HASH,
          bindingId: binding.id,
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: CONNECTOR,
          providerChatId: CHAT,
          providerThreadId: null,
          actorPlatformUserId: JOINER_HANDLE,
        })
      ).status,
    ).toBe("consented");
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({
        bindingId: binding.id,
      }),
    ).toMatchObject({ gate: "enabled", linkedParticipantCount: 2 });

    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({
        bindingId: binding.id,
      }),
    ).toMatchObject({
      gate: "restricted",
      registeredParticipantCount: 2,
      linkedParticipantCount: 1,
      consentedParticipantCount: 1,
      participants: [
        { ordinal: 1, linked: true, consented: true },
        { ordinal: 2, linked: false, consented: false },
      ],
    });
    await dbWrite
      .update(users)
      .set({ is_active: true, deleted_at: new Date() })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({
        bindingId: binding.id,
      }),
    ).toMatchObject({ gate: "restricted", linkedParticipantCount: 1 });

    const [beforeDelete] = await dbWrite
      .select({
        id: personalSharedGroupParticipants.id,
        ordinal: personalSharedGroupParticipants.ordinal,
        linkedUserId: personalSharedGroupParticipants.linked_user_id,
        consentedAt: personalSharedGroupParticipants.consented_at,
        consentProvenance: personalSharedGroupParticipants.consent_provenance,
      })
      .from(personalSharedGroupParticipants)
      .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE));
    expect(beforeDelete).toMatchObject({
      ordinal: 2,
      linkedUserId: JOINER_USER,
      consentProvenance: "authenticated_dm",
    });
    expect(beforeDelete?.consentedAt).toBeInstanceOf(Date);
    const deleteLinkedUser = async () => {
      await dbWrite.delete(users).where(eq(users.id, JOINER_USER));
    };
    await expect(deleteLinkedUser()).rejects.toThrow();
    const [preserved] = await dbWrite
      .select({
        id: personalSharedGroupParticipants.id,
        ordinal: personalSharedGroupParticipants.ordinal,
        linkedUserId: personalSharedGroupParticipants.linked_user_id,
        consentedAt: personalSharedGroupParticipants.consented_at,
        consentProvenance: personalSharedGroupParticipants.consent_provenance,
      })
      .from(personalSharedGroupParticipants)
      .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE));
    expect(preserved).toEqual(beforeDelete);
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({
        bindingId: binding.id,
      }),
    ).toMatchObject({
      gate: "restricted",
      registeredParticipantCount: 2,
      linkedParticipantCount: 1,
      consentedParticipantCount: 1,
    });
  });

  test("account deactivation revokes consent durably and reactivation cannot resurrect it", async () => {
    const binding = await bindWithEligibleJoiner();

    expect(await usersRepository.update(JOINER_USER, { is_active: false })).toMatchObject({
      id: JOINER_USER,
      is_active: false,
    });
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);
    expect(await personalSharedGroupsRepository.findBindingById(binding.id)).toMatchObject({
      authority_version: binding.authority_version + 1,
      consent_version: binding.consent_version + 1,
    });
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });

    expect(await usersRepository.update(JOINER_USER, { is_active: true })).toMatchObject({
      id: JOINER_USER,
      is_active: true,
    });
    expect(
      await dbWrite
        .select({
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([
      {
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
  });

  test("hard user deletion atomically unlinks consent and preserves the roster audit row", async () => {
    const binding = await bindWithEligibleJoiner();

    await usersRepository.delete(JOINER_USER);

    expect(
      await dbWrite.select({ id: users.id }).from(users).where(eq(users.id, JOINER_USER)),
    ).toEqual([]);
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);
    expect(await personalSharedGroupsRepository.findBindingById(binding.id)).toMatchObject({
      authority_version: binding.authority_version + 1,
      consent_version: binding.consent_version + 1,
    });
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
  });

  test("a live uncommitted delivery lease rejects account mutation without partial revocation", async () => {
    const binding = await bindWithEligibleJoiner();
    const delivery = deliveryFor(binding, true);
    expect(await personalSharedGroupsRepository.authorizeDelivery(delivery)).toMatchObject({
      authorized: true,
      leaseToken: delivery.leaseToken,
    });

    await expect(usersRepository.update(JOINER_USER, { is_active: false })).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
    });

    expect(
      await dbWrite
        .select({ isActive: users.is_active, deletedAt: users.deleted_at })
        .from(users)
        .where(eq(users.id, JOINER_USER)),
    ).toEqual([{ isActive: true, deletedAt: null }]);
    expect(
      await dbWrite
        .select({
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([
      {
        linkedUserId: JOINER_USER,
        consentedAt: expect.any(Date),
        consentProvenance: "authenticated_dm",
        revokedAt: null,
      },
    ]);
    expect(await personalSharedGroupsRepository.findBindingById(binding.id)).toMatchObject({
      authority_version: binding.authority_version,
      consent_version: binding.consent_version,
      delivery_lease_source_id: delivery.sourceMessageId,
      delivery_lease_token: delivery.leaseToken,
      delivery_lease_committed_at: null,
    });
  });

  test("revalidates the linked account immediately before consuming confirmation", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ status: "confirm_issued" });
    const confirm = () =>
      personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: CONFIRM_HASH,
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: JOINER_HANDLE,
      });

    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, JOINER_USER));
    expect(await confirm()).toEqual({ status: "account_not_authenticated" });
    await dbWrite
      .update(users)
      .set({ is_active: true, phone_number: "+15550109998" })
      .where(eq(users.id, JOINER_USER));
    expect(await confirm()).toEqual({ status: "account_not_authenticated" });
    expect(
      await dbWrite
        .select({ consumedAt: personalSharedGroupJoinChallenges.consumed_at })
        .from(personalSharedGroupJoinChallenges)
        .where(eq(personalSharedGroupJoinChallenges.code_hash, CONFIRM_HASH)),
    ).toEqual([{ consumedAt: null }]);
    expect(
      await dbWrite
        .select({
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([{ linkedUserId: null, consentedAt: null }]);

    await dbWrite
      .update(users)
      .set({ phone_number: JOINER_HANDLE })
      .where(eq(users.id, JOINER_USER));
    expect((await confirm()).status).toBe("consented");
  });

  test("serializes confirmation against account deactivation without consent resurrection", async () => {
    const binding = await bind({ consentMode: "all_adults", requiredPrincipalCount: 2 });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ status: "confirm_issued" });

    const raced = await settleWithin(
      Promise.allSettled([
        personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
          codeHash: CONFIRM_HASH,
          bindingId: binding.id,
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: CONNECTOR,
          providerChatId: CHAT,
          providerThreadId: null,
          actorPlatformUserId: JOINER_HANDLE,
        }),
        usersRepository.update(JOINER_USER, { is_active: false }),
      ]),
      "confirmation/deactivation race",
    );
    expect(raced.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      await dbWrite
        .select({ isActive: users.is_active })
        .from(users)
        .where(eq(users.id, JOINER_USER)),
    ).toEqual([{ isActive: false }]);
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
    expect(
      await dbWrite
        .select({ linkedUserId: personalSharedGroupParticipants.linked_user_id })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.platform_user_id, JOINER_HANDLE)),
    ).toEqual([{ linkedUserId: null }]);
  });

  test("serializes all-adults owner claim consumption against deactivation", async () => {
    const codeHash = "owner-claim-deactivation-race";
    await personalSharedGroupsRepository.issueClaim({
      codeHash,
      organizationId: OWNER_ORG,
      ownerUserId: OWNER_USER,
      personalAgentId: "personal:parent-a",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      issuedToPlatformUserId: OWNER_HANDLE,
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await settleWithin(
      Promise.allSettled([
        personalSharedGroupsRepository.consumeClaimAndBind({
          codeHash,
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: CONNECTOR,
          providerChatId: CHAT,
          actorPlatformUserId: OWNER_HANDLE,
        }),
        usersRepository.update(OWNER_USER, { is_active: false }),
      ]),
      "claim/deactivation race",
    );
    expect(
      await dbWrite
        .select({ isActive: users.is_active })
        .from(users)
        .where(eq(users.id, OWNER_USER)),
    ).toEqual([{ isActive: false }]);
    const current = await personalSharedGroupsRepository.resolveBinding({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      providerChatId: CHAT,
    });
    if (current) {
      expect(
        await personalSharedGroupConsentRepository.deriveConsentStatus({
          bindingId: current.id,
        }),
      ).toMatchObject({ gate: "restricted", consentedParticipantCount: 0 });
    }
  });

  test("whole rebind and revoke unlink consent while preserving participant ordinals", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
      codeHash: AUTH_HASH,
      confirmCodeHash: CONFIRM_HASH,
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR,
      actorPlatformUserId: JOINER_HANDLE,
      linkedUserId: JOINER_USER,
      linkedOrganizationId: JOINER_ORG,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(
      (
        await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
          codeHash: CONFIRM_HASH,
          bindingId: binding.id,
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: CONNECTOR,
          providerChatId: CHAT,
          providerThreadId: null,
          actorPlatformUserId: JOINER_HANDLE,
        })
      ).status,
    ).toBe("consented");

    const rebound = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    expect(rebound.id).toBe(binding.id);
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, binding.id))
        .orderBy(asc(personalSharedGroupParticipants.ordinal)),
    ).toEqual([
      {
        ordinal: 1,
        linkedUserId: OWNER_USER,
        consentedAt: expect.any(Date),
        consentProvenance: "owner_binding",
        revokedAt: null,
      },
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);

    expect(
      await personalSharedGroupsRepository.revokeBinding({
        bindingId: binding.id,
        ownerUserId: OWNER_USER,
      }),
    ).toBe(true);
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revoked: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, binding.id))
        .orderBy(asc(personalSharedGroupParticipants.ordinal)),
    ).toEqual([
      {
        ordinal: 1,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revoked: expect.any(Date),
      },
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revoked: expect.any(Date),
      },
    ]);
    await dbWrite.delete(users).where(eq(users.id, JOINER_USER));
    expect(
      await dbWrite.select({ id: users.id }).from(users).where(eq(users.id, JOINER_USER)),
    ).toEqual([]);
  });

  test("serializes all-adults rebind against a concurrent participant turn", async () => {
    const binding = await bind({ consentMode: "all_adults", requiredPrincipalCount: 2 });
    const raced = await settleWithin(
      Promise.allSettled([
        bind({ consentMode: "all_adults", requiredPrincipalCount: 2 }),
        personalSharedGroupParticipantsRepository.recordTurn({
          bindingId: binding.id,
          platformUserId: CHILD_HANDLE,
          displayName: "Child C",
        }),
      ]),
      "all-adults rebind/participant race",
    );
    expect(raced.every((result) => result.status === "fulfilled")).toBe(true);
    const roster = await dbWrite
      .select({
        platformUserId: personalSharedGroupParticipants.platform_user_id,
        ordinal: personalSharedGroupParticipants.ordinal,
      })
      .from(personalSharedGroupParticipants)
      .where(eq(personalSharedGroupParticipants.binding_id, binding.id))
      .orderBy(asc(personalSharedGroupParticipants.ordinal));
    expect(new Set(roster.map(({ ordinal }) => ordinal)).size).toBe(roster.length);
    expect(roster).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ platformUserId: OWNER_HANDLE, ordinal: 1 }),
        expect.objectContaining({ platformUserId: CHILD_HANDLE }),
      ]),
    );
  });

  test("leaving all-adults mode clears prior consent without changing single-owner defaults", async () => {
    const allAdults = await bindWithEligibleJoiner();
    const singleOwner = await bind();

    expect(singleOwner).toMatchObject({
      id: allAdults.id,
      consent_mode: "single_owner",
      required_principal_count: 1,
    });
    expect(
      await dbWrite
        .select({
          ordinal: personalSharedGroupParticipants.ordinal,
          linkedUserId: personalSharedGroupParticipants.linked_user_id,
          consentedAt: personalSharedGroupParticipants.consented_at,
          consentProvenance: personalSharedGroupParticipants.consent_provenance,
          revokedAt: personalSharedGroupParticipants.revoked_at,
        })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.binding_id, singleOwner.id))
        .orderBy(asc(personalSharedGroupParticipants.ordinal)),
    ).toEqual([
      {
        ordinal: 1,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
      {
        ordinal: 2,
        linkedUserId: null,
        consentedAt: null,
        consentProvenance: null,
        revokedAt: expect.any(Date),
      },
    ]);
  });

  test("fails closed below all-adults quorum but permits explicit consent-control delivery", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    expect(binding).toMatchObject({
      consent_mode: "all_adults",
      required_principal_count: 2,
    });
    expect(
      await personalSharedGroupsRepository.authorizeDelivery(deliveryFor(binding)),
    ).toMatchObject({ authorized: false, reason: "not_authorized" });
    expect(
      await personalSharedGroupsRepository.authorizeDelivery(deliveryFor(binding, true)),
    ).toMatchObject({ authorized: false, reason: "not_authorized" });

    const consentControl = deliveryFor(binding, false);
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
    expect(await personalSharedGroupsRepository.authorizeDelivery(consentControl)).toMatchObject({
      authorized: true,
      leaseToken: consentControl.leaseToken,
    });
    expect(await personalSharedGroupsRepository.commitDelivery(consentControl)).toBe(true);
  });

  test("authorizes an all-adults capability after eligible quorum is established", async () => {
    const binding = await bindWithEligibleJoiner();
    const delivery = deliveryFor(binding, true);
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "enabled", consentedParticipantCount: 2 });
    expect(await personalSharedGroupsRepository.authorizeDelivery(delivery)).toMatchObject({
      authorized: true,
      leaseToken: delivery.leaseToken,
    });
    expect(await personalSharedGroupsRepository.commitDelivery(delivery)).toBe(true);
  });

  test("denies all-adults capability after user, organization, or deletion ineligibility", async () => {
    const binding = await bindWithEligibleJoiner();

    await dbWrite
      .update(organizations)
      .set({ is_active: false })
      .where(eq(organizations.id, JOINER_ORG));
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({ gate: "restricted", consentedParticipantCount: 1 });
    expect(
      await personalSharedGroupsRepository.authorizeDelivery(deliveryFor(binding, true)),
    ).toMatchObject({ authorized: false, reason: "not_authorized" });
    await dbWrite
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, JOINER_ORG));

    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupsRepository.authorizeDelivery(deliveryFor(binding, true)),
    ).toMatchObject({ authorized: false, reason: "not_authorized" });

    await dbWrite
      .update(users)
      .set({ is_active: true, deleted_at: new Date() })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupsRepository.authorizeDelivery(deliveryFor(binding, true)),
    ).toMatchObject({ authorized: false, reason: "not_authorized" });
  });

  test("does not let two eligible non-owner links substitute for an ineligible owner", async () => {
    const binding = await bindWithEligibleJoiner();
    await dbWrite.insert(users).values({
      id: ADDITIONAL_NON_OWNER_USER,
      organization_id: JOINER_ORG,
      steward_user_id: "steward-additional-non-owner",
      phone_number: ADDITIONAL_NON_OWNER_HANDLE,
      phone_verified: true,
    });
    await register(binding.id, ADDITIONAL_NON_OWNER_HANDLE);
    expect(
      await personalSharedGroupConsentRepository.issueJoinAuthenticateChallenge({
        codeHash: "c".repeat(64),
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: ADDITIONAL_NON_OWNER_HANDLE,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ status: "issued" });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: "c".repeat(64),
        confirmCodeHash: "d".repeat(64),
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: ADDITIONAL_NON_OWNER_HANDLE,
        linkedUserId: ADDITIONAL_NON_OWNER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ status: "confirm_issued" });
    expect(
      await personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: "d".repeat(64),
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: ADDITIONAL_NON_OWNER_HANDLE,
      }),
    ).toMatchObject({ status: "consented" });

    const current = await personalSharedGroupsRepository.findBindingById(binding.id);
    if (!current) throw new Error("binding vanished after additional consent");
    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, OWNER_USER));

    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({ bindingId: binding.id }),
    ).toMatchObject({
      gate: "restricted",
      linkedParticipantCount: 2,
      consentedParticipantCount: 2,
    });
    expect(
      await personalSharedGroupsRepository.authorizeDelivery(deliveryFor(current, true)),
    ).toMatchObject({ authorized: false, reason: "not_authorized" });

    await dbWrite.update(users).set({ is_active: true }).where(eq(users.id, OWNER_USER));
    const inFlight = deliveryFor(current, true);
    expect(await personalSharedGroupsRepository.authorizeDelivery(inFlight)).toMatchObject({
      authorized: true,
      leaseToken: inFlight.leaseToken,
    });
    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, OWNER_USER));
    expect(await personalSharedGroupsRepository.commitDelivery(inFlight)).toBe(false);
  });

  test("refuses commit when all-adults eligibility is lost after authorization", async () => {
    const binding = await bindWithEligibleJoiner();
    const delivery = deliveryFor(binding, true);
    expect(await personalSharedGroupsRepository.authorizeDelivery(delivery)).toMatchObject({
      authorized: true,
      leaseToken: delivery.leaseToken,
    });

    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, JOINER_USER));
    expect(await personalSharedGroupsRepository.commitDelivery(delivery)).toBe(false);
    expect(
      await dbWrite
        .select({ id: personalSharedGroupDeliveryAttempts.id })
        .from(personalSharedGroupDeliveryAttempts)
        .where(eq(personalSharedGroupDeliveryAttempts.binding_id, binding.id)),
    ).toEqual([]);
  });

  test("preserves single-owner delivery when the consent marker is absent", async () => {
    const binding = await bind();
    const delivery = deliveryFor(binding);
    expect(delivery.authority).not.toHaveProperty("requiresAllAdultsConsent");
    expect(await personalSharedGroupsRepository.authorizeDelivery(delivery)).toMatchObject({
      authorized: true,
      leaseToken: delivery.leaseToken,
    });
    expect(await personalSharedGroupsRepository.commitDelivery(delivery)).toBe(true);
  });

  test("concurrent replay of one confirmation converges to one consent and one typed loser", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    expect(
      (
        await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
          codeHash: AUTH_HASH,
          confirmCodeHash: CONFIRM_HASH,
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: CONNECTOR,
          actorPlatformUserId: JOINER_HANDLE,
          linkedUserId: JOINER_USER,
          linkedOrganizationId: JOINER_ORG,
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).status,
    ).toBe("confirm_issued");

    const confirm = () =>
      personalSharedGroupConsentRepository.consumeJoinConfirmChallenge({
        codeHash: CONFIRM_HASH,
        bindingId: binding.id,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        providerChatId: CHAT,
        providerThreadId: null,
        actorPlatformUserId: JOINER_HANDLE,
      });
    const raced = await Promise.allSettled([confirm(), confirm()]);
    expect(raced.every((result) => result.status === "fulfilled")).toBe(true);
    expect(
      raced
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.status)
        .sort(),
    ).toEqual(["already_used", "consented"]);
    expect(
      await dbWrite
        .select({ id: personalSharedGroupParticipants.id })
        .from(personalSharedGroupParticipants)
        .where(eq(personalSharedGroupParticipants.linked_user_id, JOINER_USER)),
    ).toHaveLength(1);
    expect(
      await personalSharedGroupConsentRepository.deriveConsentStatus({
        bindingId: binding.id,
      }),
    ).toMatchObject({ gate: "enabled", consentedParticipantCount: 2 });
  });

  test("keeps a Blooio authenticate challenge live after a wrong-platform attempt", async () => {
    const binding = await bind({
      consentMode: "all_adults",
      requiredPrincipalCount: 2,
    });
    await register(binding.id, JOINER_HANDLE);
    await issueAuthenticate(binding.id);
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    const authenticate = (platform: "blooio" | "telegram", connectorAccountId: string) =>
      personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform,
        project: "eliza-app",
        connectorAccountId,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      });
    expect(await authenticate("telegram", "telegram:synthetic-bot")).toEqual({
      status: "wrong_scope",
    });
    expect(await authenticate("blooio", CONNECTOR)).toEqual({
      status: "confirm_issued",
      bindingId: binding.id,
      consentVersion: binding.consent_version,
    });
  });

  test("rejects join authority for single-owner bindings at issuance and direct consumption", async () => {
    const binding = await bind({ chatId: CHAT });
    await register(binding.id, JOINER_HANDLE);
    expect(await issueAuthenticate(binding.id)).toEqual({ status: "wrong_scope" });

    // Defense in depth: even a forged/stale challenge row cannot make the DM
    // consumption stage rely on the route's consent-mode branch.
    await dbWrite.insert(personalSharedGroupJoinChallenges).values({
      code_hash: AUTH_HASH,
      stage: "authenticate",
      binding_id: binding.id,
      consent_version: binding.consent_version,
      platform: "blooio",
      project: "eliza-app",
      connector_account_id: CONNECTOR,
      provider_chat_id: CHAT,
      provider_thread_id: "",
      issued_to_platform_user_id: JOINER_HANDLE,
      source_message_id: "forged-single-owner-source",
      expires_at: new Date(Date.now() + 60_000),
    });
    await dbWrite
      .update(users)
      .set({ steward_user_id: "steward-parent-b" })
      .where(eq(users.id, JOINER_USER));
    expect(
      await personalSharedGroupConsentRepository.consumeJoinAuthenticateChallenge({
        codeHash: AUTH_HASH,
        confirmCodeHash: CONFIRM_HASH,
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR,
        actorPlatformUserId: JOINER_HANDLE,
        linkedUserId: JOINER_USER,
        linkedOrganizationId: JOINER_ORG,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ status: "stale" });
  });
});
