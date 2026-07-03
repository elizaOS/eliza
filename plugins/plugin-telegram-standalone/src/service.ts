import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { type Context, Telegraf } from "telegraf";
import { handleTelegramStandaloneMessage } from "./handler";
import { shouldStartTelegramStandaloneBot } from "./policy";

export const TELEGRAM_STANDALONE_SERVICE_NAME = "telegram-standalone";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Module-level reference so a hot runtime restart can stop the previous poller
// before the next one launches — two long-polls on one bot token would fight
// over ownership and Telegram would 409 one of them.
let activeStandaloneBot: Telegraf<Context> | null = null;

function stopActiveStandaloneBot(reason: string): void {
  if (!activeStandaloneBot) {
    return;
  }
  try {
    activeStandaloneBot.stop(reason);
  } catch {
    /* ignore */
  }
  activeStandaloneBot = null;
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

      bot.on("message", async (ctx) => {
        await handleTelegramStandaloneMessage(this.runtime, ctx);
      });

      bot.catch((err: unknown) =>
        logger.warn(`[telegram-standalone] Telegram bot error: ${formatError(err)}`)
      );

      // Fire-and-forget — bot.launch() only resolves on stop().
      bot
        .launch({
          dropPendingUpdates: true,
          allowedUpdates: ["message", "message_reaction"],
        })
        .catch((err: unknown) =>
          logger.warn(`[telegram-standalone] Telegram bot launch error: ${formatError(err)}`)
        );

      this.bot = bot;
      activeStandaloneBot = bot;

      // Stop the poller on process signals in addition to the runtime's
      // service-stop path, matching the previous inline connector's SIGINT
      // handling.
      process.once("SIGINT", () => stopActiveStandaloneBot("SIGINT"));
      process.once("SIGTERM", () => stopActiveStandaloneBot("SIGTERM"));

      await new Promise((r) => setTimeout(r, 500));
      logger.info("[telegram-standalone] Telegram bot polling started");
    } catch (err) {
      logger.warn(`[telegram-standalone] Telegram bot setup failed: ${formatError(err)}`);
    }
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
    this.bot = null;
  }
}
