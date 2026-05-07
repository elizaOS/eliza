/**
 * Telegram Webhook Handler
 *
 * Receives updates from Telegram for a specific organization's bot.
 * Each organization has their own webhook URL with their orgId.
 */

import { Hono } from "hono";
import { Telegraf } from "telegraf";
import type { ChatMemberUpdated, Message, Update } from "telegraf/types";
import type { App } from "@/db/repositories/apps";
import { telegramChatsRepository } from "@/db/repositories/telegram-chats";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation/app-automation";
import { logger } from "@/lib/utils/logger";
import { isCommand } from "@/lib/utils/telegram-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

interface RouteParams {
  params: Promise<{ orgId: string }>;
}

async function handleTelegramWebhook(request: Request, context?: RouteParams): Promise<Response> {
  const { params } = context || { params: Promise.resolve({ orgId: "" }) };
  const { orgId } = await params;

  // Verify the webhook secret token from Telegram
  // See: https://core.telegram.org/bots/api#setwebhook
  const secretToken = request.headers.get("x-telegram-bot-api-secret-token");
  const storedSecret = await telegramAutomationService.getWebhookSecret(orgId);

  // In production, require secret token verification
  // In development, allow requests without secret for testing (but log a warning)
  if (storedSecret) {
    if (!secretToken) {
      logger.warn("[Telegram Webhook] Missing secret token header", { orgId });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (secretToken !== storedSecret) {
      logger.warn("[Telegram Webhook] Invalid secret token", { orgId });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // No secret configured - org doesn't have telegram set up
    // Return 200 OK to stop Telegram from retrying (webhook was likely orphaned)
    logger.warn("[Telegram Webhook] No webhook secret configured - ignoring", {
      orgId,
    });
    return Response.json({ ok: true, status: "not_configured" });
  }

  let botToken = await telegramAutomationService.getBotToken(orgId);

  // DEV ONLY: Fallback to env variable for testing
  if (!botToken && process.env.NODE_ENV === "development") {
    botToken = process.env.TELEGRAM_BOT_TOKEN || null;
    if (botToken) {
      logger.info("[Telegram Webhook] Using fallback bot token from env", {
        orgId,
      });
    }
  }

  if (!botToken) {
    logger.warn("[Telegram Webhook] No bot token for organization", { orgId });
    return Response.json({ error: "Bot not configured" }, { status: 404 });
  }

  let update: Update;
  try {
    update = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle my_chat_member updates (bot added/removed from chats)
  if ("my_chat_member" in update) {
    await handleChatMemberUpdate(orgId, update.my_chat_member);
    return Response.json({ ok: true });
  }

  // Also track chats from regular messages/posts (helps discover groups)
  if ("message" in update && update.message) {
    await trackChatFromMessage(orgId, update.message.chat, botToken);
  } else if ("channel_post" in update && update.channel_post) {
    await trackChatFromMessage(orgId, update.channel_post.chat, botToken);
  }

  const bot = new Telegraf(botToken);
  const activeApps = await telegramAppAutomationService.getAppsWithActiveAutomation(orgId);

  setupBotHandlers(bot, orgId, activeApps);

  try {
    await bot.handleUpdate(update);
  } catch (error) {
    logger.error("[Telegram Webhook] Error processing update", {
      orgId,
      updateId: update.update_id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return Response.json({ ok: true });
}

/**
 * Track a chat from a regular message/post.
 * This helps discover groups the bot is already in.
 */
async function trackChatFromMessage(
  orgId: string,
  chat: { id: number; type: string; title?: string; username?: string },
  botToken: string,
): Promise<void> {
  // Only track groups, supergroups, and channels
  if (chat.type !== "channel" && chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  // Check if already tracked
  const existing = await telegramChatsRepository.findByChatId(orgId, chat.id);
  if (existing) {
    return;
  }

  // Get bot's membership status to determine permissions
  try {
    const bot = new Telegraf(botToken);
    const botInfo = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(chat.id, botInfo.id);

    const isAdmin = member.status === "administrator" || member.status === "creator";
    const canPost = isAdmin || (member.status === "member" && chat.type !== "channel");

    await telegramChatsRepository.upsert({
      organization_id: orgId,
      chat_id: chat.id,
      chat_type: chat.type,
      title: chat.title || `Chat ${chat.id}`,
      username: chat.username,
      is_admin: isAdmin,
      can_post_messages: canPost,
    });

    logger.info("[Telegram Webhook] Discovered chat from message", {
      orgId,
      chatId: chat.id,
      chatTitle: chat.title,
      chatType: chat.type,
      isAdmin,
      canPost,
    });
  } catch (error) {
    // Silently fail - chat might be private or bot might not have access
    logger.debug("[Telegram Webhook] Could not track chat", {
      orgId,
      chatId: chat.id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

async function handleChatMemberUpdate(orgId: string, update: ChatMemberUpdated): Promise<void> {
  const chat = update.chat;
  const newStatus = update.new_chat_member.status;

  // Only track channels, groups, and supergroups
  if (chat.type !== "channel" && chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  const isAdmin = newStatus === "administrator" || newStatus === "creator";
  const isMember = isAdmin || newStatus === "member";
  const canPost = isAdmin || (newStatus === "member" && chat.type !== "channel");

  if (isMember) {
    await telegramChatsRepository.upsert({
      organization_id: orgId,
      chat_id: chat.id,
      chat_type: chat.type,
      title: chat.title,
      username: "username" in chat ? chat.username : undefined,
      is_admin: isAdmin,
      can_post_messages: canPost,
    });

    logger.info("[Telegram Webhook] Bot added to chat", {
      orgId,
      chatId: chat.id,
      chatTitle: chat.title,
      chatType: chat.type,
      status: newStatus,
    });
  } else {
    // Bot was removed (kicked, left, restricted)
    await telegramChatsRepository.delete(orgId, chat.id);

    logger.info("[Telegram Webhook] Bot removed from chat", {
      orgId,
      chatId: chat.id,
      chatTitle: chat.title,
      status: newStatus,
    });
  }
}

function setupBotHandlers(bot: Telegraf, orgId: string, activeApps: App[]) {
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const userName = ctx.from?.first_name || "there";

    const matchingApp = activeApps.find(
      (app) =>
        app.telegram_automation?.channelId === String(chatId) ||
        app.telegram_automation?.groupId === String(chatId),
    );

    if (matchingApp) {
      const welcomeMessage =
        matchingApp.telegram_automation?.welcomeMessage ||
        `Welcome to ${matchingApp.name}! I'm here to help you.`;
      await ctx.reply(welcomeMessage);
    } else {
      await ctx.reply(`Hello ${userName}! 👋 I'm an AI assistant. How can I help you today?`);
    }

    logger.info("[Telegram Webhook] Start command handled", {
      orgId,
      chatId,
      userName,
    });
  });

  bot.help(async (ctx) => {
    const helpText = `Available commands:
/start - Start the bot
/help - Show this help message
/about - Learn about this bot

You can also just send me a message and I'll do my best to help!`;

    await ctx.reply(helpText);
  });

  bot.command("about", async (ctx) => {
    const chatId = ctx.chat.id;
    const matchingApp = activeApps.find(
      (app) =>
        app.telegram_automation?.channelId === String(chatId) ||
        app.telegram_automation?.groupId === String(chatId),
    );

    if (matchingApp) {
      const aboutText = `${matchingApp.name}

${matchingApp.description || "A helpful application"}

${matchingApp.website_url ? `🌐 Website: ${matchingApp.website_url}` : ""}`;

      await ctx.reply(aboutText.trim());
    } else {
      await ctx.reply("I'm an AI assistant powered by Eliza Cloud.");
    }
  });

  bot.on("text", async (ctx) => {
    const message = ctx.message as Message.TextMessage;
    const text = message.text;

    if (isCommand(text)) return;

    const chatId = ctx.chat.id;
    const userName = ctx.from?.first_name;
    const telegramUserId = String(ctx.from?.id ?? chatId);
    const telegramUsername = ctx.from?.username ?? `telegram-${telegramUserId}`;
    const isPrivateChat = ctx.chat?.type === "private";

    if (isPrivateChat) {
      const routed = await agentGatewayRouterService.routeTelegramMessage({
        organizationId: orgId,
        chatId: String(chatId),
        messageId: message.message_id.toString(),
        content: text,
        sender: {
          id: telegramUserId,
          username: telegramUsername,
          ...(userName ? { displayName: userName } : {}),
        },
      });

      if (routed.handled) {
        const replyText = routed.replyText?.trim();
        if (replyText) {
          await ctx.reply(replyText);
        }
        return;
      }
    }

    // Route to app automation
    const matchingApp = activeApps.find(
      (app) =>
        app.telegram_automation?.channelId === String(chatId) ||
        app.telegram_automation?.groupId === String(chatId),
    );

    if (matchingApp?.telegram_automation?.autoReply) {
      try {
        await telegramAppAutomationService.handleIncomingMessage(orgId, matchingApp.id, {
          chatId,
          messageId: message.message_id,
          text,
          userName,
        });
      } catch (error) {
        logger.error("[Telegram Webhook] Error handling message", {
          orgId,
          appId: matchingApp.id,
          chatId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    } else if (!matchingApp) {
      await ctx.reply("Thanks for your message! This bot is configured for specific applications.");
    }
  });

  bot.on("channel_post", async (ctx) => {
    logger.info("[Telegram Webhook] Channel post received", {
      orgId,
      chatId: ctx.chat.id,
    });
  });

  bot.on("callback_query", async (ctx) => {
    await ctx.answerCbQuery();

    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : null;

    logger.info("[Telegram Webhook] Callback query received", {
      orgId,
      data,
    });
  });
}

const ROUTE_PARAM_SPEC = [{ name: "orgId", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.AGGRESSIVE), async (c) => {
  try {
    return await handleTelegramWebhook(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
