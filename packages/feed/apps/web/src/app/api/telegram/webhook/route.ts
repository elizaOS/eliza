/**
 * Telegram Bot Webhook Handler
 *
 * @route POST /api/telegram/webhook
 * @access Telegram servers only (verified via webhook secret)
 *
 * Lightweight MiniApp launcher bot. Responds to /start and /help with
 * a welcome message and an inline button to open the Feed MiniApp.
 *
 * Uses grammY's webhookCallback with the "std/http" adapter for
 * compatibility with Next.js App Router (Web standard Request/Response).
 */

import { withErrorHandling } from "@feed/api";
import { logger } from "@feed/shared";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

const MINIAPP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://feed.market";

function createBot(): Bot {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const bot = new Bot(token);

  const openAppKeyboard = new InlineKeyboard().webApp("Open Feed", MINIAPP_URL);

  bot.command("start", async (ctx) => {
    const firstName = ctx.from?.first_name ?? "there";

    logger.info(
      "Telegram bot /start command received",
      { userId: ctx.from?.id, username: ctx.from?.username },
      "TelegramBot",
    );

    await ctx.reply(
      `Hey ${firstName}! Welcome to Feed.\n\nTap the button below to jump in.`,
      { reply_markup: openAppKeyboard },
    );
  });

  bot.command("help", async (ctx) => {
    logger.info(
      "Telegram bot /help command received",
      { userId: ctx.from?.id },
      "TelegramBot",
    );

    await ctx.reply(
      "Feed is a prediction market game where you bet on what happens next.\n\nTap below to open the app and start playing.",
      { reply_markup: openAppKeyboard },
    );
  });

  bot.on("message", async (ctx) => {
    await ctx.reply(
      "Tap the button below to open Feed. That's where the action is.",
      {
        reply_markup: openAppKeyboard,
      },
    );
  });

  bot.catch((err) => {
    logger.error("Telegram bot error", { error: err.message }, "TelegramBot");
  });

  return bot;
}

let botInstance: Bot | null = null;

function getBot(): Bot {
  if (!botInstance) {
    botInstance = createBot();
  }
  return botInstance;
}

type WebhookHandler = (req: Request) => Response | Promise<Response>;

let handler: WebhookHandler | null = null;

function getHandler(): WebhookHandler {
  if (!handler) {
    handler = webhookCallback(getBot(), "std/http", {
      secretToken: webhookSecret,
    }) as WebhookHandler;
  }
  return handler;
}

export const POST = withErrorHandling(async function POST(
  request: Request,
): Promise<Response> {
  if (!token) {
    return new Response(JSON.stringify({ error: "Bot not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!webhookSecret) {
    return new Response(
      JSON.stringify({ error: "Webhook secret not configured" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return await getHandler()(request);
});
