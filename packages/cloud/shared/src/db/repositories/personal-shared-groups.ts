/** Atomic claim and binding authority for Personal Shared provider groups. */
import { ElizaError } from "@elizaos/core/edge";
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { type DbTransaction, dbWrite } from "../client";
import { organizations } from "../schemas/organizations";
import {
  type PersonalSharedGroupBinding,
  type PersonalSharedGroupConsentMode,
  type PersonalSharedGroupPlatform,
  type PersonalSharedGroupResponsePolicy,
  personalSharedGroupBindings,
  personalSharedGroupClaims,
  personalSharedGroupDeliveryAttempts,
  personalSharedGroupDeliveryReceipts,
  personalSharedGroupParticipants,
} from "../schemas/personal-shared-groups";
import { users } from "../schemas/users";

const PERSONAL_SHARED_GROUP_NAMESPACE = "987af3c6-5e48-4ad7-a5b6-883b51d0c904";

export function personalSharedGroupConversationId(input: {
  personalAgentId: string;
  platform: PersonalSharedGroupPlatform;
  project: string;
  connectorAccountId: string;
  providerChatId: string;
}): string {
  return `group:${uuidv5(
    [
      input.personalAgentId,
      input.platform,
      input.project,
      input.connectorAccountId,
      input.providerChatId,
    ].join("\n"),
    PERSONAL_SHARED_GROUP_NAMESPACE,
  )}`;
}

export type ConsumePersonalSharedGroupClaimResult =
  | { status: "bound"; binding: PersonalSharedGroupBinding }
  | { status: "invalid" | "expired" | "already_used" | "already_bound" };

export interface PersonalSharedGroupDeliveryAuthority {
  bindingId: string;
  ownerUserId: string;
  personalAgentId: string;
  version: number;
  /**
   * Explicitly false only for consent-control replies. Missing is fail-closed
   * for an all-adults binding so a rolling gateway cannot strip capability
   * admission and accidentally bypass the persisted consent policy.
   */
  requiresAllAdultsConsent?: boolean;
}

export interface PersonalSharedGroupDeliveryLease {
  authorized: boolean;
  leaseToken: string | null;
  expiresAt: string | null;
  reason: "source_already_attempted" | "not_authorized" | null;
  deliveryState: "committed" | "uncertain" | "reconciled" | null;
}

const DELIVERY_LEASE_MS = 90_000;
const DELIVERY_LEASE_POLL_MS = 25;
const AUTHORITY_MUTATION_WAIT_MS = 5_000;
/** Marks an abandoned worker, never the provider outcome, as uncertain. */
const COMMITTED_LEASE_RECOVERY_MS = 10 * 60_000;

export class PersonalSharedGroupDeliveryPendingError extends ElizaError {
  constructor() {
    super("A live group delivery reservation is still pending", {
      code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
      severity: "fatal",
    });
  }
}

export class PersonalSharedGroupIndependentAuthenticationRequiredError extends ElizaError {
  constructor(platform: PersonalSharedGroupPlatform, phase: "issue" | "consume") {
    super("An all-adults group owner must independently authenticate their Eliza account", {
      code: "PERSONAL_SHARED_GROUP_OWNER_INDEPENDENT_AUTHENTICATION_REQUIRED",
      severity: "fatal",
      context: { platform, phase },
    });
  }
}

async function assertIndependentlyAuthenticatedOwner(
  tx: DbTransaction,
  input: {
    ownerUserId: string;
    organizationId: string;
    platform: PersonalSharedGroupPlatform;
    platformSenderId: string;
    phase: "issue" | "consume";
  },
): Promise<void> {
  const [owner] = await tx
    .select({
      organizationId: users.organization_id,
      stewardUserId: users.steward_user_id,
      telegramId: users.telegram_id,
      phoneNumber: users.phone_number,
      phoneVerified: users.phone_verified,
      isAnonymous: users.is_anonymous,
      isActive: users.is_active,
      deletedAt: users.deleted_at,
    })
    .from(users)
    .where(eq(users.id, input.ownerUserId))
    .limit(1)
    .for("update");
  const matureSubject =
    owner &&
    !owner.stewardUserId.startsWith("phone:") &&
    !owner.stewardUserId.startsWith("telegram:");
  const providerIdentityMatches =
    owner &&
    (input.platform === "blooio"
      ? owner.phoneNumber === input.platformSenderId && owner.phoneVerified === true
      : owner.telegramId === input.platformSenderId);
  const [activeOrganization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, input.organizationId), eq(organizations.is_active, true)))
    .limit(1);
  if (
    !owner ||
    owner.organizationId !== input.organizationId ||
    !activeOrganization ||
    !owner.isActive ||
    owner.deletedAt !== null ||
    owner.isAnonymous ||
    !matureSubject ||
    !providerIdentityMatches
  ) {
    throw new PersonalSharedGroupIndependentAuthenticationRequiredError(
      input.platform,
      input.phase,
    );
  }
}

function resolveConsentConfiguration(input: {
  consentMode?: PersonalSharedGroupConsentMode;
  requiredPrincipalCount?: number;
}): { consentMode: PersonalSharedGroupConsentMode; requiredPrincipalCount: number } {
  const consentMode = input.consentMode ?? "single_owner";
  const requiredPrincipalCount = input.requiredPrincipalCount ?? 1;
  const valid =
    (consentMode === "single_owner" && requiredPrincipalCount === 1) ||
    (consentMode === "all_adults" &&
      Number.isInteger(requiredPrincipalCount) &&
      requiredPrincipalCount >= 2 &&
      requiredPrincipalCount <= 32);
  if (!valid) {
    throw new ElizaError("Personal Shared group consent configuration is invalid", {
      code: "PERSONAL_SHARED_GROUP_CONSENT_CONFIGURATION_INVALID",
      severity: "fatal",
      context: { consentMode, requiredPrincipalCount },
    });
  }
  return { consentMode, requiredPrincipalCount };
}

function deliveryLeaseAvailable(now: Date) {
  return or(
    isNull(personalSharedGroupBindings.delivery_lease_source_id),
    and(
      isNull(personalSharedGroupBindings.delivery_lease_committed_at),
      lte(personalSharedGroupBindings.delivery_lease_expires_at, now),
    ),
  );
}

function deliveryConsentAllowsEgress(authority: PersonalSharedGroupDeliveryAuthority) {
  if (authority.requiresAllAdultsConsent === false) return sql`true`;
  return or(
    eq(personalSharedGroupBindings.consent_mode, "single_owner"),
    sql`(
      SELECT
        count(*) >= ${personalSharedGroupBindings.required_principal_count}
        AND count(*) FILTER (
          WHERE participant.linked_user_id = ${personalSharedGroupBindings.owner_user_id}
        ) = 1
      FROM ${personalSharedGroupParticipants} participant
      INNER JOIN ${users} eligible_user
        ON eligible_user.id = participant.linked_user_id
      INNER JOIN ${organizations} eligible_organization
        ON eligible_organization.id = eligible_user.organization_id
        AND eligible_organization.is_active = true
      WHERE participant.binding_id = ${personalSharedGroupBindings.id}
        AND participant.revoked_at IS NULL
        AND participant.consented_at IS NOT NULL
        AND participant.consent_provenance IS NOT NULL
        AND eligible_user.is_active = true
        AND eligible_user.deleted_at IS NULL
        AND eligible_user.is_anonymous = false
        AND eligible_user.steward_user_id NOT LIKE 'phone:%'
        AND eligible_user.steward_user_id NOT LIKE 'telegram:%'
        AND (
          (${personalSharedGroupBindings.platform} = 'blooio'
            AND eligible_user.phone_number = participant.platform_user_id
            AND eligible_user.phone_verified = true)
          OR
          (${personalSharedGroupBindings.platform} = 'telegram'
            AND eligible_user.telegram_id = participant.platform_user_id)
        )
    )`,
  );
}

function deliveryLeaseAllowsAuthorityMutation(now: Date) {
  return or(
    isNull(personalSharedGroupBindings.delivery_lease_source_id),
    isNotNull(personalSharedGroupBindings.delivery_lease_committed_at),
    lte(personalSharedGroupBindings.delivery_lease_expires_at, now),
  );
}

function deliveryLeaseBlocksAuthorityMutation(now: Date) {
  return and(
    isNull(personalSharedGroupBindings.delivery_lease_committed_at),
    gt(personalSharedGroupBindings.delivery_lease_expires_at, now),
  );
}

async function waitForAuthorityMutation<T>(
  mutation: (now: Date) => Promise<T | null>,
  hasLiveLease: (now: Date) => Promise<boolean>,
): Promise<T | null> {
  const deadline = Date.now() + AUTHORITY_MUTATION_WAIT_MS;
  while (true) {
    const result = await mutation(new Date());
    if (result !== null) return result;
    const blocked = await hasLiveLease(new Date());
    if (!blocked) return null;
    if (Date.now() >= deadline) {
      throw new PersonalSharedGroupDeliveryPendingError();
    }
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_LEASE_POLL_MS));
  }
}

export const personalSharedGroupsRepository = {
  async issueClaim(input: {
    codeHash: string;
    organizationId: string;
    ownerUserId: string;
    personalAgentId: string;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    issuedToPlatformUserId: string;
    consentMode?: PersonalSharedGroupConsentMode;
    requiredPrincipalCount?: number;
    expiresAt: Date;
  }): Promise<void> {
    const consent = resolveConsentConfiguration(input);
    await dbWrite.transaction(async (tx) => {
      const now = new Date();
      if (consent.consentMode === "all_adults") {
        await assertIndependentlyAuthenticatedOwner(tx, {
          ownerUserId: input.ownerUserId,
          organizationId: input.organizationId,
          platform: input.platform,
          platformSenderId: input.issuedToPlatformUserId,
          phase: "issue",
        });
      } else {
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.ownerUserId))
          .limit(1)
          .for("update");
        if (!owner) {
          throw new ElizaError("Personal Shared group claim owner is missing", {
            code: "PERSONAL_SHARED_GROUP_CLAIM_OWNER_MISSING",
            severity: "fatal",
          });
        }
      }
      await tx
        .update(personalSharedGroupClaims)
        .set({ consumed_at: now })
        .where(
          and(
            eq(personalSharedGroupClaims.owner_user_id, input.ownerUserId),
            eq(personalSharedGroupClaims.platform, input.platform),
            eq(personalSharedGroupClaims.project, input.project),
            eq(personalSharedGroupClaims.connector_account_id, input.connectorAccountId),
            isNull(personalSharedGroupClaims.consumed_at),
          ),
        );
      await tx.insert(personalSharedGroupClaims).values({
        code_hash: input.codeHash,
        organization_id: input.organizationId,
        owner_user_id: input.ownerUserId,
        personal_agent_id: input.personalAgentId,
        platform: input.platform,
        project: input.project,
        connector_account_id: input.connectorAccountId,
        issued_to_platform_user_id: input.issuedToPlatformUserId,
        consent_mode: consent.consentMode,
        required_principal_count: consent.requiredPrincipalCount,
        expires_at: input.expiresAt,
      });
    });
  },

  async consumeClaimAndBind(input: {
    codeHash: string;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    actorPlatformUserId: string;
    verifiedAt?: Date;
  }): Promise<ConsumePersonalSharedGroupClaimResult> {
    return dbWrite.transaction(async (tx) => {
      const leaseNow = new Date();
      const now = input.verifiedAt ?? leaseNow;
      const [observedClaim] = await tx
        .select()
        .from(personalSharedGroupClaims)
        .where(eq(personalSharedGroupClaims.code_hash, input.codeHash))
        .limit(1);
      if (!observedClaim) return { status: "invalid" } as const;
      if (observedClaim.consumed_at) return { status: "already_used" } as const;
      if (observedClaim.expires_at <= now) return { status: "expired" } as const;
      if (
        observedClaim.platform !== input.platform ||
        observedClaim.project !== input.project ||
        observedClaim.connector_account_id !== input.connectorAccountId ||
        observedClaim.issued_to_platform_user_id !== input.actorPlatformUserId
      ) {
        return { status: "invalid" } as const;
      }

      // Owner authority takes the user row before the claim row. Account
      // lifecycle uses the same order, closing both FK-cascade deadlocks and
      // the no-binding-yet resurrection race during first all-adults bind.
      if (observedClaim.consent_mode === "all_adults") {
        await assertIndependentlyAuthenticatedOwner(tx, {
          ownerUserId: observedClaim.owner_user_id,
          organizationId: observedClaim.organization_id,
          platform: input.platform,
          platformSenderId: input.actorPlatformUserId,
          phase: "consume",
        });
      } else {
        const [owner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, observedClaim.owner_user_id))
          .limit(1)
          .for("update");
        if (!owner) return { status: "invalid" } as const;
      }
      const [claim] = await tx
        .update(personalSharedGroupClaims)
        .set({ consumed_at: now })
        .where(
          and(
            eq(personalSharedGroupClaims.code_hash, input.codeHash),
            eq(personalSharedGroupClaims.platform, input.platform),
            eq(personalSharedGroupClaims.project, input.project),
            eq(personalSharedGroupClaims.connector_account_id, input.connectorAccountId),
            eq(personalSharedGroupClaims.issued_to_platform_user_id, input.actorPlatformUserId),
            isNull(personalSharedGroupClaims.consumed_at),
            gt(personalSharedGroupClaims.expires_at, now),
          ),
        )
        .returning();

      if (!claim) {
        const [observed] = await tx
          .select()
          .from(personalSharedGroupClaims)
          .where(eq(personalSharedGroupClaims.code_hash, input.codeHash))
          .limit(1);
        if (!observed) return { status: "invalid" } as const;
        if (observed.consumed_at) return { status: "already_used" } as const;
        if (observed.expires_at <= now) return { status: "expired" } as const;
        return { status: "invalid" } as const;
      }

      const conversationId = personalSharedGroupConversationId({
        personalAgentId: claim.personal_agent_id,
        platform: input.platform,
        project: input.project,
        connectorAccountId: input.connectorAccountId,
        providerChatId: input.providerChatId,
      });
      const [existing] = await tx
        .select()
        .from(personalSharedGroupBindings)
        .where(
          and(
            eq(personalSharedGroupBindings.platform, input.platform),
            eq(personalSharedGroupBindings.project, input.project),
            eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
            eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
          ),
        )
        .limit(1);
      if (
        existing &&
        existing.owner_user_id !== claim.owner_user_id &&
        existing.state !== "revoked"
      ) {
        return { status: "already_bound" } as const;
      }
      const resetsAllAdultsConsent =
        claim.consent_mode === "all_adults" || existing?.consent_mode === "all_adults";
      const [binding] = await tx
        .insert(personalSharedGroupBindings)
        .values({
          organization_id: claim.organization_id,
          owner_user_id: claim.owner_user_id,
          personal_agent_id: claim.personal_agent_id,
          platform: input.platform,
          project: input.project,
          connector_account_id: input.connectorAccountId,
          provider_chat_id: input.providerChatId,
          conversation_id: conversationId,
          state: "active",
          response_policy: "mention_only",
          consent_mode: claim.consent_mode,
          required_principal_count: claim.required_principal_count,
          created_by_platform_user_id: input.actorPlatformUserId,
          last_verified_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: [
            personalSharedGroupBindings.platform,
            personalSharedGroupBindings.project,
            personalSharedGroupBindings.connector_account_id,
            personalSharedGroupBindings.provider_chat_id,
          ],
          set: {
            organization_id: claim.organization_id,
            owner_user_id: claim.owner_user_id,
            personal_agent_id: claim.personal_agent_id,
            conversation_id: conversationId,
            state: "active",
            response_policy: "mention_only",
            consent_mode: claim.consent_mode,
            required_principal_count: claim.required_principal_count,
            consent_version: sql`${personalSharedGroupBindings.consent_version} + 1`,
            authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
            delivery_lease_source_id: sql`CASE WHEN ${personalSharedGroupBindings.delivery_lease_committed_at} IS NULL THEN NULL ELSE ${personalSharedGroupBindings.delivery_lease_source_id} END`,
            delivery_lease_token: sql`CASE WHEN ${personalSharedGroupBindings.delivery_lease_committed_at} IS NULL THEN NULL ELSE ${personalSharedGroupBindings.delivery_lease_token} END`,
            delivery_lease_expires_at: sql`CASE WHEN ${personalSharedGroupBindings.delivery_lease_committed_at} IS NULL THEN NULL ELSE ${personalSharedGroupBindings.delivery_lease_expires_at} END`,
            created_by_platform_user_id: input.actorPlatformUserId,
            last_verified_at: now,
            updated_at: now,
          },
          // An active or suspended binding is tenant authority, not a
          // last-writer-wins cache entry. The existing owner may reconnect it,
          // and a deliberately revoked group may be claimed anew, but another
          // participant cannot replace a live owner's billing and policy
          // boundary merely by presenting their own valid claim.
          setWhere: and(
            or(
              eq(personalSharedGroupBindings.owner_user_id, claim.owner_user_id),
              eq(personalSharedGroupBindings.state, "revoked"),
            ),
            deliveryLeaseAllowsAuthorityMutation(leaseNow),
          ),
        })
        .returning();
      if (!binding) {
        const [current] = await tx
          .select({
            ownerUserId: personalSharedGroupBindings.owner_user_id,
            state: personalSharedGroupBindings.state,
          })
          .from(personalSharedGroupBindings)
          .where(
            and(
              eq(personalSharedGroupBindings.platform, input.platform),
              eq(personalSharedGroupBindings.project, input.project),
              eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
              eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
            ),
          )
          .limit(1);
        const mayRebind =
          current?.ownerUserId === claim.owner_user_id || current?.state === "revoked";
        if (mayRebind) {
          // Throwing rolls back claim consumption so the exact owner can retry
          // after an uncommitted lease expires or a committed send is reconciled.
          throw new PersonalSharedGroupDeliveryPendingError();
        }
        return { status: "already_bound" } as const;
      }
      if (resetsAllAdultsConsent) {
        // The upsert holds binding authority before this ordinal lock.
        // recordTurn takes a binding key-share lock first as well, keeping all
        // participant mutations on B -> advisory -> P even when ON CONFLICT
        // discovers a binding that was absent from the earlier observation.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(
            hashtext(${binding.id}),
            hashtext('personal-shared-group-participant-ordinal')
          )`,
        );
        if (existing) {
          // Rebinding an all-adults group starts a new consent epoch. Keep
          // ordinal audit rows for redaction/history, but no prior account link
          // or consent crosses that whole-binding boundary.
          await tx
            .update(personalSharedGroupParticipants)
            .set({
              linked_user_id: null,
              consented_at: null,
              consent_provenance: null,
              revoked_at: now,
            })
            .where(eq(personalSharedGroupParticipants.binding_id, binding.id));
        }
      }
      if (claim.consent_mode === "all_adults") {
        await tx.execute(sql`INSERT INTO ${personalSharedGroupParticipants}
          (binding_id, platform_user_id, ordinal, linked_user_id, consented_at,
            consent_provenance, revoked_at, last_seen_at)
        SELECT ${binding.id}::uuid, ${input.actorPlatformUserId},
          COALESCE(MAX(${personalSharedGroupParticipants.ordinal}), 0) + 1,
          ${claim.owner_user_id}::uuid, ${now}, 'owner_binding', NULL, ${now}
        FROM ${personalSharedGroupParticipants}
        WHERE ${personalSharedGroupParticipants.binding_id} = ${binding.id}::uuid
        ON CONFLICT (binding_id, platform_user_id) DO UPDATE SET
          linked_user_id = EXCLUDED.linked_user_id,
          consented_at = EXCLUDED.consented_at,
          consent_provenance = EXCLUDED.consent_provenance,
          revoked_at = NULL,
          last_seen_at = EXCLUDED.last_seen_at`);
      }
      return { status: "bound", binding } as const;
    });
  },

  /**
   * Diagnostic read of one binding by id. Outbound sends must not gate on this
   * alone; the delivery lease methods below are the authority fence, and this
   * read only explains why a lease was refused. Reads the primary like the
   * rest of this repository so it never lags the lease it diagnoses.
   */
  async findBindingById(bindingId: string): Promise<PersonalSharedGroupBinding | null> {
    const [binding] = await dbWrite
      .select()
      .from(personalSharedGroupBindings)
      .where(eq(personalSharedGroupBindings.id, bindingId))
      .limit(1);
    return binding ?? null;
  },

  async resolveBinding(input: {
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
  }): Promise<PersonalSharedGroupBinding | null> {
    const [binding] = await dbWrite
      .select()
      .from(personalSharedGroupBindings)
      .where(
        and(
          eq(personalSharedGroupBindings.platform, input.platform),
          eq(personalSharedGroupBindings.project, input.project),
          eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
          eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
        ),
      )
      .limit(1);
    return binding ?? null;
  },

  async setResponsePolicy(input: {
    bindingId: string;
    ownerUserId: string;
    policy: PersonalSharedGroupResponsePolicy;
  }): Promise<PersonalSharedGroupBinding | null> {
    return waitForAuthorityMutation(
      async (now) => {
        const [binding] = await dbWrite
          .update(personalSharedGroupBindings)
          .set({
            response_policy: input.policy,
            authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
            updated_at: now,
          })
          .where(
            and(
              eq(personalSharedGroupBindings.id, input.bindingId),
              eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
              eq(personalSharedGroupBindings.state, "active"),
              deliveryLeaseAllowsAuthorityMutation(now),
            ),
          )
          .returning();
        return binding ?? null;
      },
      async (now) => {
        const [binding] = await dbWrite
          .select({ id: personalSharedGroupBindings.id })
          .from(personalSharedGroupBindings)
          .where(
            and(
              eq(personalSharedGroupBindings.id, input.bindingId),
              eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
              deliveryLeaseBlocksAuthorityMutation(now),
            ),
          )
          .limit(1);
        return Boolean(binding);
      },
    );
  },

  async revokeBinding(input: { bindingId: string; ownerUserId: string }): Promise<boolean> {
    return Boolean(
      await waitForAuthorityMutation(
        async (now) => {
          return dbWrite.transaction(async (tx) => {
            const [binding] = await tx
              .update(personalSharedGroupBindings)
              .set({
                state: "revoked",
                authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
                consent_version: sql`${personalSharedGroupBindings.consent_version} + 1`,
                updated_at: now,
              })
              .where(
                and(
                  eq(personalSharedGroupBindings.id, input.bindingId),
                  eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
                  deliveryLeaseAllowsAuthorityMutation(now),
                ),
              )
              .returning({
                id: personalSharedGroupBindings.id,
                consentMode: personalSharedGroupBindings.consent_mode,
              });
            if (!binding) return null;
            if (binding.consentMode === "all_adults") {
              await tx
                .update(personalSharedGroupParticipants)
                .set({
                  linked_user_id: null,
                  consented_at: null,
                  consent_provenance: null,
                  revoked_at: now,
                })
                .where(eq(personalSharedGroupParticipants.binding_id, binding.id));
            }
            return binding;
          });
        },
        async (now) => {
          const [binding] = await dbWrite
            .select({ id: personalSharedGroupBindings.id })
            .from(personalSharedGroupBindings)
            .where(
              and(
                eq(personalSharedGroupBindings.id, input.bindingId),
                eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
                deliveryLeaseBlocksAuthorityMutation(now),
              ),
            )
            .limit(1);
          return Boolean(binding);
        },
      ),
    );
  },

  async applyMembershipChange(input: {
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    membershipChange: "joined" | "removed";
    verifiedAt?: Date;
  }): Promise<PersonalSharedGroupBinding | null> {
    const verifiedAt = input.verifiedAt;
    return waitForAuthorityMutation(
      async (leaseNow) => {
        const now = verifiedAt ?? leaseNow;
        const [binding] = await dbWrite
          .update(personalSharedGroupBindings)
          .set({
            state: input.membershipChange === "joined" ? "active" : "suspended",
            authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
            last_verified_at: now,
            updated_at: now,
          })
          .where(
            and(
              eq(personalSharedGroupBindings.platform, input.platform),
              eq(personalSharedGroupBindings.project, input.project),
              eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
              eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
              eq(
                personalSharedGroupBindings.state,
                input.membershipChange === "joined" ? "suspended" : "active",
              ),
              deliveryLeaseAllowsAuthorityMutation(leaseNow),
            ),
          )
          .returning();
        return binding ?? null;
      },
      async (now) => {
        const [binding] = await dbWrite
          .select({ id: personalSharedGroupBindings.id })
          .from(personalSharedGroupBindings)
          .where(
            and(
              eq(personalSharedGroupBindings.platform, input.platform),
              eq(personalSharedGroupBindings.project, input.project),
              eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
              eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
              deliveryLeaseBlocksAuthorityMutation(now),
            ),
          )
          .limit(1);
        return Boolean(binding);
      },
    );
  },

  async authorizeDelivery(input: {
    authority: PersonalSharedGroupDeliveryAuthority;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    invocation: "mention" | "command" | "reply" | "ambient";
    sourceMessageId: string;
    leaseToken: string;
  }): Promise<PersonalSharedGroupDeliveryLease> {
    return dbWrite.transaction(async (tx) => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - COMMITTED_LEASE_RECOVERY_MS);

      // A deadline can prove only that the worker disappeared. Preserve the
      // provider outcome as an addressable uncertainty before releasing the
      // live slot for a distinct source message.
      const [staleBinding] = await tx
        .select({
          bindingId: personalSharedGroupBindings.id,
          platform: personalSharedGroupBindings.platform,
          project: personalSharedGroupBindings.project,
          connectorAccountId: personalSharedGroupBindings.connector_account_id,
          providerChatId: personalSharedGroupBindings.provider_chat_id,
          sourceMessageId: personalSharedGroupBindings.delivery_lease_source_id,
          leaseToken: personalSharedGroupBindings.delivery_lease_token,
          committedAt: personalSharedGroupBindings.delivery_lease_committed_at,
        })
        .from(personalSharedGroupBindings)
        .where(
          and(
            eq(personalSharedGroupBindings.id, input.authority.bindingId),
            eq(personalSharedGroupBindings.owner_user_id, input.authority.ownerUserId),
            eq(personalSharedGroupBindings.personal_agent_id, input.authority.personalAgentId),
            eq(personalSharedGroupBindings.authority_version, input.authority.version),
            eq(personalSharedGroupBindings.platform, input.platform),
            eq(personalSharedGroupBindings.project, input.project),
            eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
            eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
            eq(personalSharedGroupBindings.state, "active"),
            isNotNull(personalSharedGroupBindings.delivery_lease_source_id),
            isNotNull(personalSharedGroupBindings.delivery_lease_token),
            lte(personalSharedGroupBindings.delivery_lease_committed_at, cutoff),
          ),
        )
        .limit(1);
      if (staleBinding?.sourceMessageId && staleBinding.leaseToken && staleBinding.committedAt) {
        // Rolling deployments may leave a commit from the old writer after
        // migration backfill. Materialize that exact attempt before release.
        await tx
          .insert(personalSharedGroupDeliveryAttempts)
          .values({
            binding_id: staleBinding.bindingId,
            platform: staleBinding.platform,
            project: staleBinding.project,
            connector_account_id: staleBinding.connectorAccountId,
            provider_chat_id: staleBinding.providerChatId,
            source_message_id: staleBinding.sourceMessageId,
            lease_token: staleBinding.leaseToken,
            state: "committed",
            committed_at: staleBinding.committedAt,
          })
          .onConflictDoNothing();
        const [uncertain] = await tx
          .update(personalSharedGroupDeliveryAttempts)
          .set({ state: "uncertain", uncertain_at: now })
          .where(
            and(
              eq(personalSharedGroupDeliveryAttempts.binding_id, staleBinding.bindingId),
              eq(
                personalSharedGroupDeliveryAttempts.source_message_id,
                staleBinding.sourceMessageId,
              ),
              eq(personalSharedGroupDeliveryAttempts.lease_token, staleBinding.leaseToken),
              eq(personalSharedGroupDeliveryAttempts.state, "committed"),
              lte(personalSharedGroupDeliveryAttempts.committed_at, cutoff),
            ),
          )
          .returning({ id: personalSharedGroupDeliveryAttempts.id });
        if (!uncertain) {
          return {
            authorized: false,
            leaseToken: null,
            expiresAt: null,
            reason: "not_authorized",
            deliveryState: null,
          };
        }
        await tx
          .update(personalSharedGroupBindings)
          .set({
            delivery_lease_source_id: null,
            delivery_lease_token: null,
            delivery_lease_expires_at: null,
            delivery_lease_committed_at: null,
          })
          .where(
            and(
              eq(personalSharedGroupBindings.id, input.authority.bindingId),
              eq(
                personalSharedGroupBindings.delivery_lease_source_id,
                staleBinding.sourceMessageId,
              ),
              eq(personalSharedGroupBindings.delivery_lease_token, staleBinding.leaseToken),
            ),
          );
      }

      const [binding] = await tx
        .update(personalSharedGroupBindings)
        .set({
          delivery_lease_source_id: input.sourceMessageId,
          delivery_lease_token: input.leaseToken,
          delivery_lease_expires_at: new Date(now.getTime() + DELIVERY_LEASE_MS),
          delivery_lease_committed_at: null,
        })
        .where(
          and(
            eq(personalSharedGroupBindings.id, input.authority.bindingId),
            eq(personalSharedGroupBindings.owner_user_id, input.authority.ownerUserId),
            eq(personalSharedGroupBindings.personal_agent_id, input.authority.personalAgentId),
            eq(personalSharedGroupBindings.authority_version, input.authority.version),
            eq(personalSharedGroupBindings.platform, input.platform),
            eq(personalSharedGroupBindings.project, input.project),
            eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
            eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
            eq(personalSharedGroupBindings.state, "active"),
            deliveryConsentAllowsEgress(input.authority),
            notExists(
              tx
                .select({ id: personalSharedGroupDeliveryAttempts.id })
                .from(personalSharedGroupDeliveryAttempts)
                .where(
                  and(
                    eq(
                      personalSharedGroupDeliveryAttempts.binding_id,
                      personalSharedGroupBindings.id,
                    ),
                    eq(
                      personalSharedGroupDeliveryAttempts.source_message_id,
                      input.sourceMessageId,
                    ),
                  ),
                ),
            ),
            notExists(
              tx
                .select({ id: personalSharedGroupDeliveryReceipts.id })
                .from(personalSharedGroupDeliveryReceipts)
                .where(
                  and(
                    eq(
                      personalSharedGroupDeliveryReceipts.binding_id,
                      personalSharedGroupBindings.id,
                    ),
                    eq(
                      personalSharedGroupDeliveryReceipts.source_message_id,
                      input.sourceMessageId,
                    ),
                  ),
                ),
            ),
            ...(input.invocation === "ambient"
              ? [eq(personalSharedGroupBindings.response_policy, "ambient")]
              : []),
            or(
              deliveryLeaseAvailable(now),
              and(
                eq(personalSharedGroupBindings.delivery_lease_source_id, input.sourceMessageId),
                eq(personalSharedGroupBindings.delivery_lease_token, input.leaseToken),
                isNull(personalSharedGroupBindings.delivery_lease_committed_at),
              ),
            ),
          ),
        )
        .returning({
          token: personalSharedGroupBindings.delivery_lease_token,
          expiresAt: personalSharedGroupBindings.delivery_lease_expires_at,
        });
      if (binding?.token === input.leaseToken && binding.expiresAt) {
        return {
          authorized: true,
          leaseToken: binding.token,
          expiresAt: binding.expiresAt.toISOString(),
          reason: null,
          deliveryState: null,
        };
      }
      const [priorAttempt] = await tx
        .select({ state: personalSharedGroupDeliveryAttempts.state })
        .from(personalSharedGroupDeliveryAttempts)
        .where(
          and(
            eq(personalSharedGroupDeliveryAttempts.binding_id, input.authority.bindingId),
            eq(personalSharedGroupDeliveryAttempts.source_message_id, input.sourceMessageId),
          ),
        )
        .limit(1);
      const [priorReceipt] = priorAttempt
        ? []
        : await tx
            .select({ id: personalSharedGroupDeliveryReceipts.id })
            .from(personalSharedGroupDeliveryReceipts)
            .where(
              and(
                eq(personalSharedGroupDeliveryReceipts.binding_id, input.authority.bindingId),
                eq(personalSharedGroupDeliveryReceipts.source_message_id, input.sourceMessageId),
              ),
            )
            .limit(1);
      return {
        authorized: false,
        leaseToken: null,
        expiresAt: null,
        reason: priorAttempt || priorReceipt ? "source_already_attempted" : "not_authorized",
        deliveryState: priorAttempt?.state ?? (priorReceipt ? "reconciled" : null),
      };
    });
  },

  /**
   * Commits the exact reserved delivery immediately before provider egress.
   * Once committed, the source/token pair is the immutable authorization
   * point. The durable attempt remains addressable after the worker vanishes,
   * so a deadline never rewrites an unknown provider outcome as non-delivery.
   */
  async commitDelivery(input: {
    authority: PersonalSharedGroupDeliveryAuthority;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    sourceMessageId: string;
    leaseToken: string;
  }): Promise<boolean> {
    return dbWrite.transaction(async (tx) => {
      const now = new Date();
      const [binding] = await tx
        .update(personalSharedGroupBindings)
        .set({
          delivery_lease_committed_at: sql`coalesce(${personalSharedGroupBindings.delivery_lease_committed_at}, ${now})`,
        })
        .where(
          and(
            eq(personalSharedGroupBindings.id, input.authority.bindingId),
            eq(personalSharedGroupBindings.owner_user_id, input.authority.ownerUserId),
            eq(personalSharedGroupBindings.personal_agent_id, input.authority.personalAgentId),
            eq(personalSharedGroupBindings.authority_version, input.authority.version),
            eq(personalSharedGroupBindings.platform, input.platform),
            eq(personalSharedGroupBindings.project, input.project),
            eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
            eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
            eq(personalSharedGroupBindings.state, "active"),
            deliveryConsentAllowsEgress(input.authority),
            eq(personalSharedGroupBindings.delivery_lease_source_id, input.sourceMessageId),
            eq(personalSharedGroupBindings.delivery_lease_token, input.leaseToken),
            or(
              isNotNull(personalSharedGroupBindings.delivery_lease_committed_at),
              gt(personalSharedGroupBindings.delivery_lease_expires_at, now),
            ),
          ),
        )
        .returning({
          token: personalSharedGroupBindings.delivery_lease_token,
          committedAt: personalSharedGroupBindings.delivery_lease_committed_at,
        });
      if (binding?.token !== input.leaseToken || !binding.committedAt) return false;
      await tx
        .insert(personalSharedGroupDeliveryAttempts)
        .values({
          binding_id: input.authority.bindingId,
          platform: input.platform,
          project: input.project,
          connector_account_id: input.connectorAccountId,
          provider_chat_id: input.providerChatId,
          source_message_id: input.sourceMessageId,
          lease_token: input.leaseToken,
          state: "committed",
          committed_at: binding.committedAt,
        })
        .onConflictDoNothing();
      const [attempt] = await tx
        .select({ leaseToken: personalSharedGroupDeliveryAttempts.lease_token })
        .from(personalSharedGroupDeliveryAttempts)
        .where(
          and(
            eq(personalSharedGroupDeliveryAttempts.binding_id, input.authority.bindingId),
            eq(personalSharedGroupDeliveryAttempts.source_message_id, input.sourceMessageId),
          ),
        )
        .limit(1);
      if (attempt?.leaseToken !== input.leaseToken) {
        throw new ElizaError("Delivery source was already committed under another lease", {
          code: "PERSONAL_SHARED_GROUP_DELIVERY_ATTEMPT_CONFLICT",
          severity: "fatal",
          context: { bindingId: input.authority.bindingId, sourceMessageId: input.sourceMessageId },
        });
      }
      return true;
    });
  },

  async recordDeliveryReceipts(input: {
    authority: PersonalSharedGroupDeliveryAuthority;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    sourceMessageId: string;
    providerMessageIds: string[];
    leaseToken: string;
  }): Promise<{ recorded: boolean; inserted: number }> {
    return dbWrite.transaction(async (tx) => {
      const expected = new Set(input.providerMessageIds);
      // The source/token pair was durably committed before provider egress.
      // Its attempt remains authoritative even after the live slot is released
      // for a distinct source, so late provider receipts stay reconcilable.
      let [attempt] = await tx
        .select({ bindingId: personalSharedGroupDeliveryAttempts.binding_id })
        .from(personalSharedGroupDeliveryAttempts)
        .where(
          and(
            eq(personalSharedGroupDeliveryAttempts.binding_id, input.authority.bindingId),
            eq(personalSharedGroupDeliveryAttempts.platform, input.platform),
            eq(personalSharedGroupDeliveryAttempts.project, input.project),
            eq(personalSharedGroupDeliveryAttempts.connector_account_id, input.connectorAccountId),
            eq(personalSharedGroupDeliveryAttempts.provider_chat_id, input.providerChatId),
            eq(personalSharedGroupDeliveryAttempts.source_message_id, input.sourceMessageId),
            eq(personalSharedGroupDeliveryAttempts.lease_token, input.leaseToken),
            inArray(personalSharedGroupDeliveryAttempts.state, [
              "committed",
              "uncertain",
              "reconciled",
            ]),
          ),
        )
        .limit(1);

      // A previous revision can commit the binding during a rolling deploy
      // without knowing about the attempts table. Lock and materialize that
      // exact authority before accepting its provider receipt; no broader or
      // expired binding is allowed to stand in for the source/token pair.
      if (!attempt) {
        const [legacyCommit] = await tx
          .select({
            bindingId: personalSharedGroupBindings.id,
            committedAt: personalSharedGroupBindings.delivery_lease_committed_at,
          })
          .from(personalSharedGroupBindings)
          .where(
            and(
              eq(personalSharedGroupBindings.id, input.authority.bindingId),
              eq(personalSharedGroupBindings.owner_user_id, input.authority.ownerUserId),
              eq(personalSharedGroupBindings.personal_agent_id, input.authority.personalAgentId),
              eq(personalSharedGroupBindings.authority_version, input.authority.version),
              eq(personalSharedGroupBindings.platform, input.platform),
              eq(personalSharedGroupBindings.project, input.project),
              eq(personalSharedGroupBindings.connector_account_id, input.connectorAccountId),
              eq(personalSharedGroupBindings.provider_chat_id, input.providerChatId),
              eq(personalSharedGroupBindings.delivery_lease_source_id, input.sourceMessageId),
              eq(personalSharedGroupBindings.delivery_lease_token, input.leaseToken),
              isNotNull(personalSharedGroupBindings.delivery_lease_committed_at),
            ),
          )
          .limit(1)
          .for("update");
        if (legacyCommit?.committedAt) {
          await tx
            .insert(personalSharedGroupDeliveryAttempts)
            .values({
              binding_id: legacyCommit.bindingId,
              platform: input.platform,
              project: input.project,
              connector_account_id: input.connectorAccountId,
              provider_chat_id: input.providerChatId,
              source_message_id: input.sourceMessageId,
              lease_token: input.leaseToken,
              state: "committed",
              committed_at: legacyCommit.committedAt,
            })
            .onConflictDoNothing();
          [attempt] = await tx
            .select({ bindingId: personalSharedGroupDeliveryAttempts.binding_id })
            .from(personalSharedGroupDeliveryAttempts)
            .where(
              and(
                eq(personalSharedGroupDeliveryAttempts.binding_id, input.authority.bindingId),
                eq(personalSharedGroupDeliveryAttempts.platform, input.platform),
                eq(personalSharedGroupDeliveryAttempts.project, input.project),
                eq(
                  personalSharedGroupDeliveryAttempts.connector_account_id,
                  input.connectorAccountId,
                ),
                eq(personalSharedGroupDeliveryAttempts.provider_chat_id, input.providerChatId),
                eq(personalSharedGroupDeliveryAttempts.source_message_id, input.sourceMessageId),
                eq(personalSharedGroupDeliveryAttempts.lease_token, input.leaseToken),
              ),
            )
            .limit(1);
        }
      }
      if (!attempt || input.providerMessageIds.length === 0) {
        return { recorded: false, inserted: 0 };
      }
      const inserted = await tx
        .insert(personalSharedGroupDeliveryReceipts)
        .values(
          input.providerMessageIds.map((providerMessageId) => ({
            binding_id: attempt.bindingId,
            platform: input.platform,
            project: input.project,
            connector_account_id: input.connectorAccountId,
            provider_chat_id: input.providerChatId,
            source_message_id: input.sourceMessageId,
            provider_message_id: providerMessageId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: personalSharedGroupDeliveryReceipts.id });
      const recorded = await tx
        .select({
          providerMessageId: personalSharedGroupDeliveryReceipts.provider_message_id,
          sourceMessageId: personalSharedGroupDeliveryReceipts.source_message_id,
        })
        .from(personalSharedGroupDeliveryReceipts)
        .where(
          and(
            eq(personalSharedGroupDeliveryReceipts.binding_id, attempt.bindingId),
            inArray(
              personalSharedGroupDeliveryReceipts.provider_message_id,
              input.providerMessageIds,
            ),
          ),
        );
      const durable = new Set(
        recorded
          .filter((receipt) => receipt.sourceMessageId === input.sourceMessageId)
          .map((receipt) => receipt.providerMessageId),
      );
      const result = {
        recorded: durable.size === expected.size && [...expected].every((id) => durable.has(id)),
        inserted: inserted.length,
      };
      if (result.recorded) {
        const reconciledAt = new Date();
        await tx
          .update(personalSharedGroupDeliveryAttempts)
          .set({ state: "reconciled", reconciled_at: reconciledAt })
          .where(
            and(
              eq(personalSharedGroupDeliveryAttempts.binding_id, input.authority.bindingId),
              eq(personalSharedGroupDeliveryAttempts.source_message_id, input.sourceMessageId),
              eq(personalSharedGroupDeliveryAttempts.lease_token, input.leaseToken),
            ),
          );
        await tx
          .update(personalSharedGroupBindings)
          .set({
            delivery_lease_source_id: null,
            delivery_lease_token: null,
            delivery_lease_expires_at: null,
            delivery_lease_committed_at: null,
          })
          .where(
            and(
              eq(personalSharedGroupBindings.id, attempt.bindingId),
              eq(personalSharedGroupBindings.delivery_lease_source_id, input.sourceMessageId),
              eq(personalSharedGroupBindings.delivery_lease_token, input.leaseToken),
            ),
          );
      }
      return result;
    });
  },

  async listUncertainDeliveryAttempts(input: {
    bindingId: string;
    ownerUserId: string;
    limit: number;
  }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ElizaError("Uncertain delivery report limit must be between 1 and 100", {
        code: "PERSONAL_SHARED_GROUP_UNCERTAIN_REPORT_LIMIT_INVALID",
        severity: "fatal",
        context: { limit: input.limit },
      });
    }
    return dbWrite
      .select({ ...getTableColumns(personalSharedGroupDeliveryAttempts) })
      .from(personalSharedGroupDeliveryAttempts)
      .innerJoin(
        personalSharedGroupBindings,
        eq(personalSharedGroupBindings.id, personalSharedGroupDeliveryAttempts.binding_id),
      )
      .where(
        and(
          eq(personalSharedGroupDeliveryAttempts.state, "uncertain"),
          eq(personalSharedGroupDeliveryAttempts.binding_id, input.bindingId),
          eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
        ),
      )
      .orderBy(
        desc(personalSharedGroupDeliveryAttempts.uncertain_at),
        desc(personalSharedGroupDeliveryAttempts.id),
      )
      .limit(input.limit);
  },

  async hasDeliveryReceipt(input: {
    bindingId: string;
    providerMessageId: string;
  }): Promise<boolean> {
    const [receipt] = await dbWrite
      .select({ id: personalSharedGroupDeliveryReceipts.id })
      .from(personalSharedGroupDeliveryReceipts)
      .where(
        and(
          eq(personalSharedGroupDeliveryReceipts.binding_id, input.bindingId),
          eq(personalSharedGroupDeliveryReceipts.provider_message_id, input.providerMessageId),
        ),
      )
      .limit(1);
    return Boolean(receipt);
  },
};
