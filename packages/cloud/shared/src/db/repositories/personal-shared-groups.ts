/** Atomic claim and binding authority for Personal Shared provider groups. */
import { ElizaError } from "@elizaos/core";
import { and, eq, gt, inArray, isNotNull, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { dbWrite } from "../client";
import {
  type PersonalSharedGroupBinding,
  type PersonalSharedGroupPlatform,
  type PersonalSharedGroupResponsePolicy,
  personalSharedGroupBindings,
  personalSharedGroupClaims,
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
}

const DELIVERY_LEASE_MS = 90_000;
const DELIVERY_LEASE_POLL_MS = 25;
const AUTHORITY_MUTATION_WAIT_MS = 5_000;

export class PersonalSharedGroupDeliveryPendingError extends ElizaError {
  constructor() {
    super("A committed group delivery has no durable provider receipt", {
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

function deliveryLeaseBlocksAuthority(now: Date) {
  return or(
    isNotNull(personalSharedGroupBindings.delivery_lease_committed_at),
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
      const now = input.verifiedAt ?? new Date();
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
            created_by_platform_user_id: input.actorPlatformUserId,
            last_verified_at: now,
            updated_at: now,
          },
          // An active or suspended binding is tenant authority, not a
          // last-writer-wins cache entry. The existing owner may reconnect it,
          // and a deliberately revoked group may be claimed anew, but another
          // participant cannot replace a live owner's billing and policy
          // boundary merely by presenting their own valid claim.
          setWhere: or(
            eq(personalSharedGroupBindings.owner_user_id, claim.owner_user_id),
            eq(personalSharedGroupBindings.state, "revoked"),
          ),
        })
        .returning();
      if (!binding) return { status: "already_bound" } as const;
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
              deliveryLeaseAvailable(now),
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
              deliveryLeaseBlocksAuthority(now),
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
                deliveryLeaseAvailable(now),
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
                deliveryLeaseBlocksAuthority(now),
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
              deliveryLeaseAvailable(leaseNow),
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
              deliveryLeaseBlocksAuthority(now),
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
    const now = new Date();
    const [binding] = await dbWrite
      .update(personalSharedGroupBindings)
      .set({
        delivery_lease_source_id: input.sourceMessageId,
        delivery_lease_token: input.leaseToken,
        delivery_lease_expires_at: new Date(now.getTime() + DELIVERY_LEASE_MS),
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
            dbWrite
              .select({ id: personalSharedGroupDeliveryReceipts.id })
              .from(personalSharedGroupDeliveryReceipts)
              .where(
                and(
                  eq(
                    personalSharedGroupDeliveryReceipts.binding_id,
                    personalSharedGroupBindings.id,
                  ),
                  eq(personalSharedGroupDeliveryReceipts.source_message_id, input.sourceMessageId),
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
            ),
          ),
        ),
      )
      .returning({
        token: personalSharedGroupBindings.delivery_lease_token,
        expiresAt: personalSharedGroupBindings.delivery_lease_expires_at,
      });
    return binding?.token === input.leaseToken && binding.expiresAt
      ? {
          authorized: true,
          leaseToken: binding.token,
          expiresAt: binding.expiresAt.toISOString(),
        }
      : { authorized: false, leaseToken: null, expiresAt: null };
  },

  /**
   * Commits the exact reserved delivery immediately before provider egress.
   * Once committed, authority changes wait for its receipt instead of taking
   * over by wall-clock expiry. A crash after this point therefore fails closed
   * rather than allowing another worker to create an ambiguous second send.
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
    const now = new Date();
    const [binding] = await dbWrite
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
      .returning({ token: personalSharedGroupBindings.delivery_lease_token });
    return binding?.token === input.leaseToken;
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
      if (expected.size > 0) {
        const prior = await tx
          .select({
            providerMessageId: personalSharedGroupDeliveryReceipts.provider_message_id,
            sourceMessageId: personalSharedGroupDeliveryReceipts.source_message_id,
          })
          .from(personalSharedGroupDeliveryReceipts)
          .where(
            and(
              eq(personalSharedGroupDeliveryReceipts.binding_id, input.authority.bindingId),
              inArray(
                personalSharedGroupDeliveryReceipts.provider_message_id,
                input.providerMessageIds,
              ),
            ),
          );
        const durablePrior = new Set(
          prior
            .filter((receipt) => receipt.sourceMessageId === input.sourceMessageId)
            .map((receipt) => receipt.providerMessageId),
        );
        if (
          durablePrior.size === expected.size &&
          [...expected].every((id) => durablePrior.has(id))
        ) {
          return { recorded: true, inserted: 0 };
        }
      }
      const [binding] = await tx
        .select({ id: personalSharedGroupBindings.id })
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
            eq(personalSharedGroupBindings.delivery_lease_source_id, input.sourceMessageId),
            eq(personalSharedGroupBindings.delivery_lease_token, input.leaseToken),
            isNotNull(personalSharedGroupBindings.delivery_lease_committed_at),
          ),
        )
        .limit(1);
      if (!binding || input.providerMessageIds.length === 0) {
        return { recorded: false, inserted: 0 };
      }
      const inserted = await tx
        .insert(personalSharedGroupDeliveryReceipts)
        .values(
          input.providerMessageIds.map((providerMessageId) => ({
            binding_id: binding.id,
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
            eq(personalSharedGroupDeliveryReceipts.binding_id, binding.id),
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
              eq(personalSharedGroupBindings.id, binding.id),
              eq(personalSharedGroupBindings.delivery_lease_source_id, input.sourceMessageId),
              eq(personalSharedGroupBindings.delivery_lease_token, input.leaseToken),
            ),
          );
      }
      return result;
    });
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
