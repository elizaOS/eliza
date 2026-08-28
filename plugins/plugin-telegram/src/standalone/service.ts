/** Owns the opt-in standalone Telegram poller and its process-wide token lock. */
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import { telegramStatusToMembership } from "../membership";
import {
  createTelegramMembershipGate,
  type TelegramMembershipGate,
  TelegramMembershipMessageGate,
} from "../membership-gate";
import {
  claimTelegramPollerToken,
  getTelegramPollerClaim,
  markTelegramPollerConnected,
  markTelegramPollerTerminated,
  markTelegramPollerUpdate,
  releaseTelegramPollerToken,
  type TelegramPollerHealth,
} from "../poller-lock";
import { handleTelegramStandaloneMessage } from "./handler";
import { shouldStartTelegramStandaloneBot } from "./policy";

export const TELEGRAM_STANDALONE_SERVICE_NAME = "telegram-standalone";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Module-level reference lets this service stop its own previous standalone
// poller during hot restart. Cross-mode ownership is enforced by the shared
// poller lock, which preserves a hard failure for a live full-service owner.
let activeStandaloneBot: Telegraf<Context> | null = null;
let activeStandaloneToken: string | null = null;

function stopActiveStandaloneBot(reason: string): void {
  if (!activeStandaloneBot) {
    return;
  }
  const bot = activeStandaloneBot;
  const token = activeStandaloneToken;
  try {
    bot.stop(reason);
  } catch (error) {
    // error-policy:J6 Poller teardown is best-effort during restart or signal
    // handling; the lock is still released below and the failure is visible.
    logger.debug(
      `[telegram-standalone] Telegram poller stop failed: ${formatError(error)}`,
    );
  }
  if (token) {
    releaseTelegramPollerToken(token, bot);
  }
  activeStandaloneBot = null;
  activeStandaloneToken = null;
}

/**
 * Opt-in standalone Telegram polling bot — the standalone mode of
 * `@elizaos/plugin-telegram`. Registered as a runtime Service so the runtime
 * owns its start/stop lifecycle.
 *
 * `start()` is a no-op unless {@link shouldStartTelegramStandaloneBot} is true
 * (LifeOps passive connectors disabled AND `ELIZA_TELEGRAM_STANDALONE_BOT` set)
 * — the service self-gates, so loading the Telegram plugin without the gate
 * never launches a poller.
 */
export class TelegramStandaloneService extends Service {
  static serviceType = TELEGRAM_STANDALONE_SERVICE_NAME;
  capabilityDescription =
    "Opt-in standalone Telegram polling bot (gate ELIZA_TELEGRAM_STANDALONE_BOT).";

  private bot: Telegraf<Context> | null = null;
  private botToken: string | null = null;
  /**
   * Membership admission gate for the standalone poller — the same
   * authority the full TelegramService uses, so standalone group admission
   * and bot kick/re-add tombstoning cannot bypass the membership authority.
   * Null while bootstrap is pending; the message gate instance fails closed
   * (pending) until the gate settles absent/failed. Constructed lazily in
   * launch() with the REAL runtime: every warning/denial path in
   * TelegramMembershipMessageGate dereferences runtime.agentId, so a
   * null-runtime gate would throw instead of denying (and throw instead of
   * the documented absent-authority allow mode).
   */
  private admissionGate: TelegramMembershipMessageGate | null = null;

  static async start(
    runtime: IAgentRuntime,
  ): Promise<TelegramStandaloneService> {
    const service = new TelegramStandaloneService(runtime);
    if (!shouldStartTelegramStandaloneBot(process.env, runtime)) {
      return service;
    }
    await service.launch();
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const existing = runtime.getService(TELEGRAM_STANDALONE_SERVICE_NAME);
    if (existing) {
      await (existing as TelegramStandaloneService).stop();
    }
  }

  /**
   * Bootstraps the standalone membership gate BEFORE polling can deliver
   * updates: resolve bot identity, seed the authority gate, and bind the
   * admission gate. A FAILED bootstrap marks the gate broken (group
   * admission fails closed); an absent authority settles to the legacy
   * allow mode.
   */
  private async bootstrapMembershipGate(bot: Telegraf<Context>): Promise<void> {
    this.gate().markPending();
    try {
      const botInfo = await bot.telegram.getMe();
      const gate = await createTelegramMembershipGate({
        runtime: this.runtime,
        botTelegramUserId: String(botInfo.id),
      });
      if (gate) {
        this.membershipGate = gate;
        this.gate().rebind(gate.authority, gate.botTelegramUserId);
      } else {
        this.gate().markAbsent();
      }
    } catch (error) {
      // error-policy:J2 Bootstrap failure must not degrade to the absent-
      // authority allow mode: mark broken so group admission fails closed.
      this.gate().markBroken();
      this.runtime.reportError(
        "telegram-standalone:membership-bootstrap",
        error,
        {
          accountId: "default",
        },
      );
    }
  }

  /**
   * Applies the bot's own chat-member status transition from a
   * `my_chat_member` update — same contract as the full TelegramService:
   * kicked/left tombstones the scope (fail-closed admission for the whole
   * chat); a revoked→present transition clears the tombstone.
   */
  private async handleMyChatMemberUpdate(
    update:
      | {
          chat?: { id: number | string };
          new_chat_member?: { status: string; user: { id: number } };
          old_chat_member?: { status: string; user: { id: number } };
        }
      | undefined,
  ): Promise<void> {
    const gate = this.membershipGate;
    if (!gate || !update?.chat || !update.new_chat_member) {
      return;
    }
    try {
      if (
        update.new_chat_member.user.id.toString() !== gate.botTelegramUserId
      ) {
        return;
      }
      const chatId = update.chat.id.toString();
      const membership = telegramStatusToMembership(update.new_chat_member);
      const previous = telegramStatusToMembership(
        update.old_chat_member ?? update.new_chat_member,
      );
      if (membership.state === "revoked") {
        await gate.authority.markScopeUnavailable({
          chatId,
          chatRoomKey: chatId,
          reason: "bot_removed",
        });
        return;
      }
      if (previous.state === "revoked") {
        await gate.authority.clearScopeRemoval({
          chatId,
          chatRoomKey: chatId,
        });
      }
    } catch (error) {
      // error-policy:J2 The tombstone/clear could not be applied; the scope
      // may still authorize on stale evidence. Mark the admission gate
      // broken so every group admission fails closed.
      this.gate().markBroken();
      this.membershipGate = null;
      this.runtime.reportError(
        "telegram-standalone:membership-scope-health",
        error,
        {
          chatId: update?.chat?.id?.toString() ?? "unknown",
          accountId: "default",
          reason: "bot_removed",
          source: "my_chat_member",
        },
      );
    }
  }

  private membershipGate: TelegramMembershipGate | null = null;

  /**
   * The admission gate consulted for standalone group admission. Never null
   * once launch() begins (constructed with the real runtime there); the
   * non-null assertion documents that bot.on("message") handlers only run
   * after launch() has created it.
   */
  private gate(): TelegramMembershipMessageGate {
    return this.admissionGate as TelegramMembershipMessageGate;
  }

  private async launch(): Promise<void> {
    // Stop any previous poller (hot restart) before launching a new one.
    if (activeStandaloneBot) {
      stopActiveStandaloneBot("restart");
      await new Promise((r) => setTimeout(r, 1000));
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return;

    try {
      const apiRoot =
        process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
      const bot = new Telegraf(botToken, { telegram: { apiRoot } });
      this.bot = bot;
      this.botToken = botToken;
      // Construct the admission gate with the REAL runtime BEFORE any
      // handler can consult it: the gate's warning/denial paths
      // dereference runtime.agentId, so a null-runtime gate would throw
      // instead of returning a decision.
      this.admissionGate = new TelegramMembershipMessageGate({
        runtime: this.runtime,
        authority: null,
        botTelegramUserId: null,
      });
      claimTelegramPollerToken(botToken, {
        bot,
        mode: "standalone",
        ownerId: String(this.runtime.agentId),
        accountId: "default",
      });

      bot.on("message", async (ctx) => {
        markTelegramPollerUpdate(botToken, bot);
        await handleTelegramStandaloneMessage(this.runtime, ctx, {
          admissionGate: this.gate(),
          // Live membership-status provider so the gate's reconcile path can
          // admit an ordinary active member whose scope evidence is missing
          // or expired — without it authority-backed standalone groups could
          // only admit principals with already-current durable evidence.
          getChatMember: async (chatId, userId) =>
            await ctx.telegram.getChatMember(chatId, Number(userId)),
        });
      });

      // The bot's own chat-member status transitions (kick/leave/re-add):
      // while polling, my_chat_member is the ONLY signal that the bot was
      // removed from a chat — without it the standalone poller could never
      // tombstone a scope and stale evidence would keep authorizing members
      // of a chat the bot can no longer observe.
      bot.on("my_chat_member", async (ctx) => {
        markTelegramPollerUpdate(botToken, bot);
        await this.handleMyChatMemberUpdate(ctx.update.my_chat_member);
      });

      bot.catch((err: unknown) => {
        // error-policy:J7 Telegraf observes handler failures here; report them
        // without terminating the long-poll loop.
        this.runtime.reportError("telegram-standalone:handler", err, {
          accountId: "default",
        });
        logger.warn(
          `[telegram-standalone] Telegram bot error: ${formatError(err)}`,
        );
      });

      // Membership gate must settle BEFORE polling can deliver updates:
      // getMe + authority bootstrap happen here, ahead of bot.launch(). A
      // kick/re-add delivered before the gate existed would otherwise be
      // dropped (or admitted through the pending window) — this is the
      // standalone mirror of the full service's startup-window contract.
      await this.bootstrapMembershipGate(bot);

      // Fire-and-forget — bot.launch() only resolves on stop().
      bot
        .launch(
          {
            dropPendingUpdates: false,
            allowedUpdates: ["message", "message_reaction", "my_chat_member"],
          },
          () => {
            markTelegramPollerConnected(botToken, bot);
          },
        )
        .catch((err: unknown) => {
          // error-policy:J4 A terminated background poller becomes an explicit
          // unhealthy service state and is reported through runtime diagnostics.
          markTelegramPollerTerminated(botToken, bot, err);
          this.runtime.reportError("telegram-standalone:poller", err, {
            accountId: "default",
          });
          logger.warn(
            `[telegram-standalone] Telegram bot launch error: ${formatError(err)}`,
          );
        });

      activeStandaloneBot = bot;
      activeStandaloneToken = botToken;

      // Stop the poller on process signals in addition to the runtime's
      // service-stop path, matching the previous inline connector's SIGINT
      // handling.
      process.once("SIGINT", () => stopActiveStandaloneBot("SIGINT"));
      process.once("SIGTERM", () => stopActiveStandaloneBot("SIGTERM"));

      await new Promise((r) => setTimeout(r, 500));
      logger.info("[telegram-standalone] Telegram bot polling started");
    } catch (err) {
      if (botToken && this.bot) {
        releaseTelegramPollerToken(botToken, this.bot);
      }
      this.bot = null;
      this.botToken = null;
      // error-policy:J2 Setup failure must fail plugin startup after releasing
      // process-local ownership, with the original error preserved as cause.
      throw new ElizaError("Telegram standalone poller setup failed", {
        code: "TELEGRAM_STANDALONE_SETUP_FAILED",
        cause: err,
        context: { accountId: "default" },
      });
    }
  }

  public getPollerHealth(): TelegramPollerHealth {
    if (!this.botToken || !this.bot) {
      return {
        ok: false,
        mode: "standalone",
        accountId: "default",
        ownerId: String(this.runtime.agentId),
        connected: false,
        lastError: "Telegram standalone poller is not launched",
      };
    }
    const claim = getTelegramPollerClaim(this.botToken);
    if (claim?.bot === this.bot) {
      const { bot: _bot, ...health } = claim;
      return health;
    }
    return {
      ok: false,
      mode: "standalone",
      accountId: "default",
      ownerId: String(this.runtime.agentId),
      connected: false,
      lastError: "Telegram standalone poller lock is not active",
    };
  }

  async stop(): Promise<void> {
    if (this.bot && this.bot === activeStandaloneBot) {
      stopActiveStandaloneBot("service-stop");
    } else if (this.bot) {
      try {
        this.bot.stop("service-stop");
      } catch (error) {
        // error-policy:J6 Runtime shutdown still releases the poller lock; a
        // stop failure is observable but cannot safely block teardown.
        logger.debug(
          `[telegram-standalone] Telegram poller stop failed: ${formatError(error)}`,
        );
      }
    }
    if (this.botToken && this.bot) {
      releaseTelegramPollerToken(this.botToken, this.bot);
    }
    this.bot = null;
    this.botToken = null;
  }
}
