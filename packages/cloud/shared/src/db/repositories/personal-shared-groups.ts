/** Atomic claim and binding authority for Personal Shared provider groups. */
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
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
            eq(
              personalSharedGroupClaims.connector_account_id,
              input.connectorAccountId,
            ),
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
            eq(
              personalSharedGroupClaims.connector_account_id,
              input.connectorAccountId,
            ),
            eq(
              personalSharedGroupClaims.issued_to_platform_user_id,
              input.actorPlatformUserId,
            ),
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
            eq(
              personalSharedGroupBindings.connector_account_id,
              input.connectorAccountId,
            ),
            eq(
              personalSharedGroupBindings.provider_chat_id,
              input.providerChatId,
            ),
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
          eq(
            personalSharedGroupBindings.connector_account_id,
            input.connectorAccountId,
          ),
          eq(
            personalSharedGroupBindings.provider_chat_id,
            input.providerChatId,
          ),
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
    const [binding] = await dbWrite
      .update(personalSharedGroupBindings)
      .set({
        response_policy: input.policy,
        authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(personalSharedGroupBindings.id, input.bindingId),
          eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
          eq(personalSharedGroupBindings.state, "active"),
        ),
      )
      .returning();
    return binding ?? null;
  },

  async revokeBinding(input: {
    bindingId: string;
    ownerUserId: string;
  }): Promise<boolean> {
    const [binding] = await dbWrite
      .update(personalSharedGroupBindings)
      .set({
        state: "revoked",
        authority_version: sql`${personalSharedGroupBindings.authority_version} + 1`,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(personalSharedGroupBindings.id, input.bindingId),
          eq(personalSharedGroupBindings.owner_user_id, input.ownerUserId),
        ),
      )
      .returning({ id: personalSharedGroupBindings.id });
    return Boolean(binding);
  },

  async applyMembershipChange(input: {
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    membershipChange: "joined" | "removed";
    verifiedAt?: Date;
  }): Promise<PersonalSharedGroupBinding | null> {
    const now = input.verifiedAt ?? new Date();
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
          eq(
            personalSharedGroupBindings.connector_account_id,
            input.connectorAccountId,
          ),
          eq(
            personalSharedGroupBindings.provider_chat_id,
            input.providerChatId,
          ),
          eq(
            personalSharedGroupBindings.state,
            input.membershipChange === "joined" ? "suspended" : "active",
          ),
        ),
      )
      .returning();
    return binding ?? null;
  },

  async authorizeDelivery(input: {
    authority: PersonalSharedGroupDeliveryAuthority;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    invocation: "mention" | "command" | "reply" | "ambient";
  }): Promise<boolean> {
    const [binding] = await dbWrite
      .select({ id: personalSharedGroupBindings.id })
      .from(personalSharedGroupBindings)
      .where(
        and(
          eq(personalSharedGroupBindings.id, input.authority.bindingId),
          eq(
            personalSharedGroupBindings.owner_user_id,
            input.authority.ownerUserId,
          ),
          eq(
            personalSharedGroupBindings.personal_agent_id,
            input.authority.personalAgentId,
          ),
          eq(
            personalSharedGroupBindings.authority_version,
            input.authority.version,
          ),
          eq(personalSharedGroupBindings.platform, input.platform),
          eq(personalSharedGroupBindings.project, input.project),
          eq(
            personalSharedGroupBindings.connector_account_id,
            input.connectorAccountId,
          ),
          eq(
            personalSharedGroupBindings.provider_chat_id,
            input.providerChatId,
          ),
          eq(personalSharedGroupBindings.state, "active"),
          ...(input.invocation === "ambient"
            ? [eq(personalSharedGroupBindings.response_policy, "ambient")]
            : []),
        ),
      )
      .limit(1);
    return Boolean(binding);
  },

  async recordDeliveryReceipts(input: {
    authority: PersonalSharedGroupDeliveryAuthority;
    platform: PersonalSharedGroupPlatform;
    project: string;
    connectorAccountId: string;
    providerChatId: string;
    sourceMessageId: string;
    providerMessageIds: string[];
  }): Promise<{ recorded: boolean; inserted: number }> {
    return dbWrite.transaction(async (tx) => {
      const [binding] = await tx
        .select({ id: personalSharedGroupBindings.id })
        .from(personalSharedGroupBindings)
        .where(
          and(
            eq(personalSharedGroupBindings.id, input.authority.bindingId),
            eq(
              personalSharedGroupBindings.owner_user_id,
              input.authority.ownerUserId,
            ),
            eq(
              personalSharedGroupBindings.personal_agent_id,
              input.authority.personalAgentId,
            ),
            eq(
              personalSharedGroupBindings.authority_version,
              input.authority.version,
            ),
            eq(personalSharedGroupBindings.platform, input.platform),
            eq(personalSharedGroupBindings.project, input.project),
            eq(
              personalSharedGroupBindings.connector_account_id,
              input.connectorAccountId,
            ),
            eq(
              personalSharedGroupBindings.provider_chat_id,
              input.providerChatId,
            ),
            eq(personalSharedGroupBindings.state, "active"),
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
          providerMessageId:
            personalSharedGroupDeliveryReceipts.provider_message_id,
          sourceMessageId:
            personalSharedGroupDeliveryReceipts.source_message_id,
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
      const expected = new Set(input.providerMessageIds);
      const durable = new Set(
        recorded
          .filter(
            (receipt) => receipt.sourceMessageId === input.sourceMessageId,
          )
          .map((receipt) => receipt.providerMessageId),
      );
      return {
        recorded:
          durable.size === expected.size &&
          [...expected].every((id) => durable.has(id)),
        inserted: inserted.length,
      };
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
          eq(
            personalSharedGroupDeliveryReceipts.provider_message_id,
            input.providerMessageId,
          ),
        ),
      )
      .limit(1);
    return Boolean(receipt);
  },
};
