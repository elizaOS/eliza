/**
 * Membership admission gate for inbound Telegram group/supergroup messages:
 * consults the canonical membership authority, reconciles via `getChatMember`
 * on evidence-miss denials (backfill for never-seen members, refresh for
 * quiet scopes), re-authorizes once, and fails closed when the authority or
 * the provider query cannot produce fresh evidence.
 */
import type { UUID } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import type { TelegramMembershipAuthority } from "./membership";
import {
  resolveMembershipService,
  telegramMembershipShouldReconcile,
} from "./membership";

const CONNECTOR_ACCOUNT_PROVIDER = "telegram";

/**
 * Durable connector-account bootstrap: upserts the (agent, "telegram",
 * <bot telegram user id>) row through the ConnectorAccountManager so the
 * membership authority's connector-account FK resolves to a stable UUID.
 */
export async function bootstrapTelegramMembershipAccount(input: {
  agentId: UUID;
  botTelegramUserId: string;
  runtime: import("@elizaos/core").IAgentRuntime;
}): Promise<UUID | null> {
  try {
    const { getConnectorAccountManager } = await import("@elizaos/core");
    const manager = getConnectorAccountManager(input.runtime);
    const now = Date.now();
    const account: import("@elizaos/core").ConnectorAccount = {
      id: `telegram-${input.botTelegramUserId}`,
      provider: CONNECTOR_ACCOUNT_PROVIDER,
      label: `Telegram bot ${input.botTelegramUserId}`,
      role: "AGENT",
      purpose: ["messaging"],
      accessGate: "open",
      status: "connected",
      externalId: input.botTelegramUserId,
      createdAt: now,
      updatedAt: now,
    };
    const stored = await manager.upsertAccount(
      CONNECTOR_ACCOUNT_PROVIDER,
      account,
    );
    if (!stored.id || !isUuidLike(stored.id)) {
      // The authority service IS configured, but its connector-account store
      // returned a malformed result. This must NOT degrade to the
      // absent-authority legacy allow mode (null): throw so the caller marks
      // the admission gate broken and every group admission fails closed.
      throw new ElizaError(
        "Telegram membership bootstrap received a non-UUID connector account id",
        {
          code: "TELEGRAM_MEMBERSHIP_BOOTSTRAP_INVALID_ACCOUNT",
          context: {
            botTelegramUserId: input.botTelegramUserId,
            storedId: stored.id ?? null,
          },
        },
      );
    }
    return stored.id as UUID;
  } catch (error) {
    // error-policy:J2 Bootstrap failure must stay distinguishable from an
    // absent connector-account manager: wrap and rethrow so the service
    // records a BROKEN gate (fail-closed group admission) instead of
    // silently degrading to the absent-authority legacy allow mode.
    throw new ElizaError(
      "Telegram membership connector-account bootstrap failed",
      {
        code: "TELEGRAM_MEMBERSHIP_BOOTSTRAP_FAILED",
        cause: error,
      },
    );
  }
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export interface TelegramMembershipGate {
  authority: TelegramMembershipAuthority;
  connectorAccountId: UUID;
  botTelegramUserId: string;
}

/** Builds the per-account authority gate, or null when the authority service is absent. */
export async function createTelegramMembershipGate(input: {
  runtime: import("@elizaos/core").IAgentRuntime;
  botTelegramUserId: string;
}): Promise<TelegramMembershipGate | null> {
  const service = resolveMembershipService(input.runtime);
  if (!service) {
    return null;
  }
  const connectorAccountId = await bootstrapTelegramMembershipAccount({
    agentId: input.runtime.agentId,
    botTelegramUserId: input.botTelegramUserId,
    runtime: input.runtime,
  });
  if (!connectorAccountId) {
    return null;
  }
  const { TelegramMembershipAuthority: Authority } = await import(
    "./membership"
  );
  return {
    authority: new Authority({
      runtime: input.runtime,
      connectorAccountId,
      service,
    }),
    connectorAccountId,
    botTelegramUserId: input.botTelegramUserId,
  };
}

export interface TelegramMembershipGateDecisionInput {
  chatId: string;
  chatRoomKey: string;
  chatType: string;
  principalEntityId: UUID;
  telegramUserId: string;
  runtimeMapping: {
    worldId: UUID | null;
    roomId: UUID | null;
    entityId: UUID | null;
  };
  getChatMember: () => Promise<{
    status: string;
    custom_title?: string;
    user: { id: number };
  }>;
}

export class TelegramMembershipMessageGate {
  private readonly runtime: import("@elizaos/core").IAgentRuntime;
  private authority: TelegramMembershipAuthority | null;
  private botTelegramUserId: string | null;
  private broken = false;
  /**
   * True between manager construction and the first gate resolution: the
   * poller is live before finishBotStartup settles, and admission must not
   * degrade to the absent-authority allow mode during that window — a
   * revoked sender could otherwise slip in before the authority binds.
   */
  private pending = false;
  private readonly warned = new Set<string>();
  private reconcileNonce = 0;

  constructor(input: {
    runtime: import("@elizaos/core").IAgentRuntime;
    authority: TelegramMembershipAuthority | null;
    botTelegramUserId: string | null;
  }) {
    this.runtime = input.runtime;
    this.authority = input.authority;
    this.botTelegramUserId = input.botTelegramUserId;
  }

  /** Late-binds the authority client and bot identity once bootstrapped. */
  rebind(
    authority: TelegramMembershipAuthority,
    botTelegramUserId: string,
  ): void {
    this.authority = authority;
    this.botTelegramUserId = botTelegramUserId;
    this.broken = false;
    this.pending = false;
    this.warned.clear();
  }

  /**
   * Marks the gate pending: the authority's bootstrap is in flight, so
   * group admission fails closed until rebind/markBroken/markAbsent settles
   * it. Distinct from absent (legacy allow) and broken (fail closed).
   */
  markPending(): void {
    this.pending = true;
    this.warned.clear();
  }

  /** Settles a pending gate into the absent-authority legacy mode. */
  markAbsent(): void {
    this.pending = false;
    this.authority = null;
    this.warned.clear();
  }

  /**
   * Marks the gate broken: the membership authority was configured but its
   * bootstrap failed. Group admission fails closed until a later boot
   * succeeds — this is distinct from the absent-authority legacy mode.
   */
  markBroken(): void {
    this.broken = true;
    this.pending = false;
    this.authority = null;
    this.warned.clear();
  }

  /** True when the message may proceed to memory creation. */
  async authorizeMessage(
    input: TelegramMembershipGateDecisionInput,
  ): Promise<boolean> {
    // The bot's own messages are not membership-gated (its membership is not
    // tracked by the authority; outbound paths own their own discipline).
    if (
      this.botTelegramUserId &&
      input.telegramUserId === this.botTelegramUserId
    ) {
      return true;
    }
    if (
      this.broken ||
      this.pending ||
      (!this.authority && process.env.TELEGRAM_MEMBERSHIP_ENFORCE === "1")
    ) {
      // Broken bootstrap (authority configured but failed), pending
      // bootstrap (poller live before the gate settles — fail closed for
      // that window), or explicit strict mode without an authority:
      // admission fails closed.
      this.warnOnce(
        this.pending
          ? `authority-pending:${input.chatId}`
          : `authority-broken:${input.chatId}`,
        "Telegram group admission denied: membership authority is unavailable",
        { chatId: input.chatId },
      );
      return false;
    }
    if (!this.authority) {
      // The membership authority service was never registered (deployment
      // without plugin-sql): admission degrades to allow with a once-per-chat
      // structured warning — revoking every group message for deployments that
      // never opted into membership authority would be a silent availability
      // regression. TELEGRAM_MEMBERSHIP_ENFORCE opts into strict fail-closed.
      // When the service IS present but scope evidence is stale or
      // unavailable, the deny path below still fails closed.
      this.warnOnce(
        `authority-absent:${input.chatId}`,
        "Telegram group admission running without a membership authority service; membership checks disabled",
        { chatId: input.chatId },
      );
      return true;
    }
    const decision = await this.authority.authorize({
      chatId: input.chatId,
      chatRoomKey: input.chatRoomKey,
      canonicalPrincipalId: input.principalEntityId,
    });
    if (decision.decision === "allowed") {
      return true;
    }
    if (telegramMembershipShouldReconcile(decision)) {
      const reconciled = await this.authority.reconcile({
        chatId: input.chatId,
        chatRoomKey: input.chatRoomKey,
        canonicalPrincipalId: input.principalEntityId,
        telegramUserId: input.telegramUserId,
        runtime: input.runtimeMapping,
        getChatMember: input.getChatMember,
        nonce: `${Date.now()}-${++this.reconcileNonce}`,
      });
      if (reconciled?.state === "active") {
        const recheck = await this.authority.authorize({
          chatId: input.chatId,
          chatRoomKey: input.chatRoomKey,
          canonicalPrincipalId: input.principalEntityId,
        });
        if (recheck.decision === "allowed") {
          return true;
        }
        this.logDenial(input, recheck.reason, "post-reconcile");
        return false;
      }
      this.logDenial(
        input,
        reconciled ? reconciled.reason : decision.reason,
        reconciled ? "reconciled-revoked" : "reconcile-failed",
      );
      return false;
    }
    this.logDenial(input, decision.reason, "authority");
    return false;
  }

  private logDenial(
    input: TelegramMembershipGateDecisionInput,
    reason: string,
    stage: string,
  ): void {
    logger.warn(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        chatId: input.chatId,
        chatType: input.chatType,
        telegramUserId: input.telegramUserId,
        reason,
        stage,
      },
      "Telegram group message denied by membership authority",
    );
  }

  private warnOnce(key: string, message: string, context: unknown): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(
      {
        src: "plugin:telegram",
        agentId: this.runtime.agentId,
        ...(context as {
          chatId?: string;
        }),
      },
      message,
    );
  }
}
