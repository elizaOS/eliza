/**
 * Telegram Webhook Handler
 *
 * Receives updates from Telegram for a specific organization's bot.
 * Each organization has their own webhook URL with their orgId.
 */

import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { Telegraf } from "telegraf";
import type { ChatMemberUpdated, Message, Update } from "telegraf/types";
import type { App } from "@/db/repositories/apps";
import { telegramChatsRepository } from "@/db/repositories/telegram-chats";
import { webhookEventsRepository } from "@/db/repositories/webhook-events";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  nextStyleParams,
  type RouteContext,
} from "@/lib/api/hono-next-style-params";
import { timingSafeEqualSecret } from "@/lib/auth/cron";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { agentGatewayRouterService } from "@/lib/services/agent-gateway-router";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { telegramAppAutomationService } from "@/lib/services/telegram-automation/app-automation";
import { logger } from "@/lib/utils/logger";
import { isCommand } from "@/lib/utils/telegram-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

function allowUnverifiedTelegramDevWebhook(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV === "1"
  );
}

async function handleTelegramWebhook(
  request: Request,
  context?: RouteContext<{ orgId: string }>,
): Promise<Response> {
  const { params } = context || { params: Promise.resolve({ orgId: "" }) };
  const { orgId } = await params;

  // Verify the webhook secret token from Telegram
  // See: https://core.telegram.org/bots/api#setwebhook
  const secretToken = request.headers.get("x-telegram-bot-api-secret-token");
  const storedSecret = await telegramAutomationService.getWebhookSecret(orgId);

  // Fail closed: a stored secret ALWAYS requires a matching, timing-safe token.
  // When no secret is stored the org hasn't wired telegram up (or the webhook
  // is orphaned) — we must not process an unauthenticated update. Previously the
  // non-production branch fell through and handled the update with NO auth at
  // all (finding L4). The only allowed bypass is an explicit, development-only
  // env flag that logs loudly; it is never the silent default. (#12878 / #12227)
  if (storedSecret) {
    if (!secretToken) {
      logger.warn("[Telegram Webhook] Missing secret token header", { orgId });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!timingSafeEqualSecret(secretToken, storedSecret)) {
      logger.warn("[Telegram Webhook] Invalid secret token", { orgId });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    if (!allowUnverifiedTelegramDevWebhook()) {
      // Orphaned/unconfigured webhook. Return 200 so Telegram stops retrying,
      // but do NOT process the update.
      logger.warn(
        "[Telegram Webhook] No webhook secret configured - ignoring update",
        {
          orgId,
          env: process.env.NODE_ENV,
          hint: "Set TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED_DEV=1 for local tunnel testing only.",
        },
      );
      return Response.json({ ok: true, status: "not_configured" });
    }
    logger.warn("[Telegram Webhook] Accepting unverified development webhook", {
      orgId,
    });
  }

  let botToken = await telegramAutomationService.getBotToken(orgId);

  // DEV ONLY: explicit opt-in fallback for local tunnel testing.
  if (!botToken && allowUnverifiedTelegramDevWebhook()) {
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

  // Replay dedupe on Telegram's monotonic `update_id` (matches other signed
  // provider webhooks). Telegram re-delivers an update until it gets a
  // 200, so without this a slow handler causes the same message to be routed to
  // the agent multiple times (duplicate reply + double credit spend). Scoped per
  // org so two orgs' independent update_id sequences can't collide. (finding L4)
  const dedupeEventId =
    typeof update.update_id === "number"
      ? `telegram:${orgId}:${update.update_id}`
      : null;
  if (dedupeEventId) {
    const dedupe = await webhookEventsRepository.tryCreate({
      event_id: dedupeEventId,
      provider: "telegram",
      event_type: "update",
      payload_hash: String(update.update_id),
    });
    if (!dedupe.created) {
      logger.warn("[Telegram Webhook] Duplicate update ignored", {
        orgId,
        updateId: update.update_id,
      });
      return Response.json({ ok: true, status: "duplicate" });
    }
  }

  // The dedupe marker is committed BEFORE processing, so if any handling step
  // throws we must roll it back — otherwise the marker "poisons" this update_id
  // and Telegram's retry is short-circuited as a duplicate, dropping the update
  // forever. On failure: delete the marker and re-throw so the route returns a
  // 5xx and the provider retry re-processes (matches the shared webhook
  // rollback-on-failed-enqueue pattern). (finding L4)
  try {
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
    const activeApps =
      await telegramAppAutomationService.getAppsWithActiveAutomation(orgId);

    setupBotHandlers(bot, orgId, activeApps);

    await bot.handleUpdate(update);
  } catch (error) {
    if (dedupeEventId) {
      try {
        await webhookEventsRepository.deleteByEventId(
          dedupeEventId,
          "telegram",
        );
      } catch (rollbackError) {
        // error-policy:J2 Preserve both failures for the transport boundary.
        throw new ElizaError(
          "Telegram webhook handling and dedupe rollback both failed",
          {
            code: "TELEGRAM_WEBHOOK_ROLLBACK_FAILED",
            context: { orgId, updateId: update.update_id },
            cause: new AggregateError([error, rollbackError]),
          },
        );
      }
    }
    throw error;
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
  if (
    chat.type !== "channel" &&
    chat.type !== "group" &&
    chat.type !== "supergroup"
  ) {
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

    const isAdmin =
      member.status === "administrator" || member.status === "creator";
    const canPost =
      isAdmin || (member.status === "member" && chat.type !== "channel");

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

async function handleChatMemberUpdate(
  orgId: string,
  update: ChatMemberUpdated,
): Promise<void> {
  const chat = update.chat;
  const newStatus = update.new_chat_member.status;

  // Only track channels, groups, and supergroups
  if (
    chat.type !== "channel" &&
    chat.type !== "group" &&
    chat.type !== "supergroup"
  ) {
    return;
  }

  const isAdmin = newStatus === "administrator" || newStatus === "creator";
  const isMember = isAdmin || newStatus === "member";
  const canPost =
    isAdmin || (newStatus === "member" && chat.type !== "channel");

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
      await ctx.reply(
        `Hello ${userName}! 👋 I'm an AI assistant. How can I help you today?`,
      );
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
    const matchingApp = activeApps.find(
      (app) =>
        app.telegram_automation?.channelId === String(chatId) ||
        app.telegram_automation?.groupId === String(chatId),
    );

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
        // An explicitly configured app automation owns unknown first-contact
        // traffic. Known users still route to their agent because the router
        // consults this flag only after identity resolution returns no owner.
        onboardUnknownOwner: !matchingApp?.telegram_automation?.autoReply,
      });

      if (routed.handled) {
        const replyText = routed.replyText?.trim();
        if (replyText) {
          await ctx.reply(replyText);
        }
        return;
      }

      if (routed.reason === "owner_org_mismatch") {
        logger.warn(
          "[Telegram Webhook] Refusing cross-organization owner fallback",
          { orgId, chatId, telegramUserId },
        );
        return;
      }
    }

    // Route to app automation
    if (matchingApp?.telegram_automation?.autoReply) {
      const result = await telegramAppAutomationService.handleIncomingMessage(
        orgId,
        matchingApp.id,
        {
          chatId,
          messageId: message.message_id,
          text,
          userName,
        },
      );
      if (!result.success) {
        throw new ElizaError("Telegram app automation reply failed", {
          code: "TELEGRAM_APP_AUTOMATION_REPLY_FAILED",
          context: {
            orgId,
            appId: matchingApp.id,
            chatId,
            error: result.error,
          },
        });
      }
    } else if (!matchingApp) {
      await ctx.reply(
        "Thanks for your message! This bot is configured for specific applications.",
      );
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
    return await handleTelegramWebhook(
      c.req.raw,
      nextStyleParams(c, ROUTE_PARAM_SPEC),
    );
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
