import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import { handleTelegramStandaloneMessage } from "./handler";
import { shouldStartTelegramStandaloneBot } from "./policy";
import {
  claimTelegramPollerToken,
  getTelegramPollerClaim,
  markTelegramPollerConnected,
  markTelegramPollerError,
  markTelegramPollerUpdate,
  releaseTelegramPollerToken,
  type TelegramPollerHealth,
} from "./poller-lock";

export const TELEGRAM_STANDALONE_SERVICE_NAME = "telegram-standalone";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Module-level reference so a hot runtime restart can stop the previous poller
// before the next one launches — two long-polls on one bot token would fight
// over ownership and Telegram would 409 one of them.
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
  } catch {
    /* ignore */
  }
  if (token) {
    releaseTelegramPollerToken(token, bot);
  }
  activeStandaloneBot = null;
  activeStandaloneToken = null;
}

/**
 * Opt-in standalone Telegram polling bot. Registered as a runtime Service so
 * the runtime owns its start/stop lifecycle; it replaces the connector that
 * used to be inlined in the app-core boot orchestrator.
 *
 * `start()` is a no-op unless {@link shouldStartTelegramStandaloneBot} is true
 * (LifeOps passive connectors disabled AND `ELIZA_TELEGRAM_STANDALONE_BOT` set)
 * — the plugin is only loaded under that gate, but the service self-gates too
 * so a stale load never launches a poller.
 */
export class TelegramStandaloneService extends Service {
  static serviceType = TELEGRAM_STANDALONE_SERVICE_NAME;
  capabilityDescription =
    "Opt-in standalone Telegram polling bot (gate ELIZA_TELEGRAM_STANDALONE_BOT).";

  private bot: Telegraf<Context> | null = null;
  private botToken: string | null = null;

  static async start(runtime: IAgentRuntime): Promise<TelegramStandaloneService> {
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
      const apiRoot = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
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

      bot.catch((err: unknown) =>
        logger.warn(`[telegram-standalone] Telegram bot error: ${formatError(err)}`)
      );

      // Fire-and-forget — bot.launch() only resolves on stop().
      bot
        .launch(
          {
            dropPendingUpdates: false,
            allowedUpdates: ["message", "message_reaction"],
          },
          () => {
            markTelegramPollerConnected(botToken, bot);
          }
        )
        .catch((err: unknown) => {
          markTelegramPollerError(botToken, bot, err);
          logger.warn(`[telegram-standalone] Telegram bot launch error: ${formatError(err)}`);
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
      logger.warn(`[telegram-standalone] Telegram bot setup failed: ${formatError(err)}`);
      throw err;
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
      } catch {
        /* ignore */
      }
    }
    if (this.botToken && this.bot) {
      releaseTelegramPollerToken(this.botToken, this.bot);
    }
    this.bot = null;
    this.botToken = null;
  }
}
