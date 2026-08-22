/** Atomic claim and binding authority for Personal Shared provider groups. */
import { ElizaError } from "@elizaos/core";
import {
  and,
  desc,
  eq,
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
import { dbWrite } from "../client";
import {
  type PersonalSharedGroupBinding,
  type PersonalSharedGroupPlatform,
  type PersonalSharedGroupResponsePolicy,
  personalSharedGroupBindings,
  personalSharedGroupClaims,
  personalSharedGroupDeliveryAttempts,
  personalSharedGroupDeliveryReceipts,
} from "../schemas/personal-shared-groups";

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
}

export interface PersonalSharedGroupDeliveryLease {
  authorized: boolean;
  leaseToken: string | null;
  expiresAt: string | null;
  reason: "source_already_attempted" | "not_authorized" | null;
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

function deliveryLeaseAvailable(now: Date) {
  return or(
    isNull(personalSharedGroupBindings.delivery_lease_source_id),
    and(
      isNull(personalSharedGroupBindings.delivery_lease_committed_at),
      lte(personalSharedGroupBindings.delivery_lease_expires_at, now),
    ),
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
    expiresAt: Date;
  }): Promise<void> {
    await dbWrite.transaction(async (tx) => {
      const now = new Date();
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
      return { status: "bound", binding } as const;
    });
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
          const [binding] = await dbWrite
            .update(personalSharedGroupBindings)
            .set({
              state: "revoked",
              authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
              updated_at: now,
            })
            .where(
              and(
                eq(personalSharedGroupBindings.id, input.bindingId),
                eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
                deliveryLeaseAllowsAuthorityMutation(now),
              ),
            )
            .returning({ id: personalSharedGroupBindings.id });
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
        };
      }
      const [priorAttempt] = await tx
        .select({ id: personalSharedGroupDeliveryAttempts.id })
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
      const [attempt] = await tx
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

  async listUncertainDeliveryAttempts(input: { bindingId?: string; limit: number }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new ElizaError("Uncertain delivery report limit must be between 1 and 100", {
        code: "PERSONAL_SHARED_GROUP_UNCERTAIN_REPORT_LIMIT_INVALID",
        severity: "fatal",
        context: { limit: input.limit },
      });
    }
    return dbWrite
      .select()
      .from(personalSharedGroupDeliveryAttempts)
      .where(
        and(
          eq(personalSharedGroupDeliveryAttempts.state, "uncertain"),
          ...(input.bindingId
            ? [eq(personalSharedGroupDeliveryAttempts.binding_id, input.bindingId)]
            : []),
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
