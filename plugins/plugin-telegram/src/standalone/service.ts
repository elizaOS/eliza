/** Owns the opt-in standalone Telegram poller and its process-wide token lock. */
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
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

  static async start(
    runtime: IAgentRuntime,
  ): Promise<TelegramStandaloneService> {
    const service = new TelegramStandaloneService(runtime);
    if (!shouldStartTelegramStandaloneBot()) {
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
      claimTelegramPollerToken(botToken, {
        bot,
        mode: "standalone",
        ownerId: String(this.runtime.agentId),
        accountId: "default",
      });

      bot.on("message", async (ctx) => {
        markTelegramPollerUpdate(botToken, bot);
        await handleTelegramStandaloneMessage(this.runtime, ctx);
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

      // Fire-and-forget — bot.launch() only resolves on stop().
      bot
        .launch(
          {
            dropPendingUpdates: false,
            allowedUpdates: ["message", "message_reaction"],
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
