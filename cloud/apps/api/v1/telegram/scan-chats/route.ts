import { Hono } from "hono";
import { Telegraf } from "telegraf";
import type { Update } from "telegraf/types";
import { telegramChatsRepository } from "@/db/repositories/telegram-chats";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

// Type guard helpers for Telegram Update types
function hasMyChatMember(update: Update): update is Update.MyChatMemberUpdate {
  return "my_chat_member" in update;
}

function hasMessage(update: Update): update is Update.MessageUpdate {
  return "message" in update;
}

function hasChannelPost(update: Update): update is Update.ChannelPostUpdate {
  return "channel_post" in update;
}

/**
 * GET /api/v1/telegram/scan-chats
 * Returns stored Telegram chats for the organization.
 */
app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const allChats = await telegramChatsRepository.findByOrganization(user.organization_id);

    return c.json({
      success: true,
      chats: allChats.map((chat) => ({
        id: chat.chat_id.toString(),
        type: chat.chat_type,
        title: chat.title,
        username: chat.username,
        isAdmin: chat.is_admin,
        canPost: chat.can_post_messages,
      })),
    });
  } catch (error) {
    logger.error("[Telegram Chats] Failed to fetch chats", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

/**
 * POST /api/v1/telegram/scan-chats
 * Scans for new chats via Telegram API and stores them.
 */
app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const botToken = await telegramAutomationService.getBotToken(user.organization_id);

    if (!botToken) {
      return c.json({ error: "Telegram bot not connected" }, 400);
    }

    const bot = new Telegraf(botToken);

    // Remove webhook temporarily to use getUpdates
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    logger.info("[Telegram Scan] Webhook deleted, fetching updates...", {
      organizationId: user.organization_id,
    });

    // Get recent updates (includes my_chat_member events)
    const updates = await bot.telegram.getUpdates(0, 100, 0, [
      "my_chat_member",
      "message",
      "channel_post",
    ]);

    logger.info("[Telegram Scan] Got updates from Telegram", {
      organizationId: user.organization_id,
      updateCount: updates.length,
      updateTypes: updates.map((u) => {
        if (hasMyChatMember(u)) return "my_chat_member";
        if (hasMessage(u)) return "message";
        if (hasChannelPost(u)) return "channel_post";
        return "unknown";
      }),
    });

    const chatsFound: Array<{
      chatId: number;
      title: string;
      type: string;
      username?: string;
    }> = [];

    const seenChatIds = new Set<number>();

    // Get bot info for checking membership
    const botInfo = await bot.telegram.getMe();

    for (const update of updates) {
      type ChatInfo = {
        id: number;
        title?: string;
        type: string;
        username?: string;
      };
      let chat: ChatInfo | null = null;

      if (hasMyChatMember(update)) {
        const ch = update.my_chat_member.chat;
        chat = {
          id: ch.id,
          type: ch.type,
          title: "title" in ch ? ch.title : undefined,
          username: "username" in ch ? ch.username : undefined,
        };
      } else if (hasMessage(update)) {
        const ch = update.message.chat;
        chat = {
          id: ch.id,
          type: ch.type,
          title: "title" in ch ? ch.title : undefined,
          username: "username" in ch ? ch.username : undefined,
        };
      } else if (hasChannelPost(update)) {
        const ch = update.channel_post.chat;
        chat = {
          id: ch.id,
          type: ch.type,
          title: "title" in ch ? ch.title : undefined,
          username: "username" in ch ? ch.username : undefined,
        };
      }

      if (
        chat &&
        !seenChatIds.has(chat.id) &&
        (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel")
      ) {
        seenChatIds.add(chat.id);

        // Check bot's actual membership status
        let isAdmin = false;
        let canPost = false;
        try {
          const member = await bot.telegram.getChatMember(chat.id, botInfo.id);
          isAdmin = member.status === "administrator" || member.status === "creator";
          canPost = isAdmin || (member.status === "member" && chat.type !== "channel");
        } catch {
          // If we can't check membership, assume basic permissions for groups
          canPost = chat.type !== "channel";
        }

        // Save to database
        await telegramChatsRepository.upsert({
          organization_id: user.organization_id,
          chat_id: chat.id,
          chat_type: chat.type,
          title: chat.title || `Chat ${chat.id}`,
          username: chat.username,
          is_admin: isAdmin,
          can_post_messages: canPost,
        });

        chatsFound.push({
          chatId: chat.id,
          title: chat.title || `Chat ${chat.id}`,
          type: chat.type,
          username: chat.username,
        });
      }
    }

    // Also refresh existing chats' status
    const existingChats = await telegramChatsRepository.findByOrganization(user.organization_id);
    for (const existingChat of existingChats) {
      if (!seenChatIds.has(existingChat.chat_id)) {
        try {
          const member = await bot.telegram.getChatMember(existingChat.chat_id, botInfo.id);
          const isAdmin = member.status === "administrator" || member.status === "creator";
          const canPost =
            isAdmin || (member.status === "member" && existingChat.chat_type !== "channel");

          // Update if permissions changed
          if (existingChat.is_admin !== isAdmin || existingChat.can_post_messages !== canPost) {
            await telegramChatsRepository.upsert({
              organization_id: user.organization_id,
              chat_id: existingChat.chat_id,
              chat_type: existingChat.chat_type,
              title: existingChat.title,
              username: existingChat.username ?? undefined,
              is_admin: isAdmin,
              can_post_messages: canPost,
            });
          }
        } catch {
          // Bot might have been removed from this chat - leave as is for now
        }
      }
    }

    // Re-set the webhook using the centralized service (ensures secret_token is included)
    const webhookResult = await telegramAutomationService.setWebhook(user.organization_id);
    if (webhookResult.success) {
      logger.info("[Telegram Scan] Webhook set via service", {
        organizationId: user.organization_id,
      });
    } else {
      logger.info("[Telegram Scan] Webhook setup skipped or failed", {
        organizationId: user.organization_id,
        error: webhookResult.error,
      });
    }

    logger.info("[Telegram Scan] Scanned for chats", {
      organizationId: user.organization_id,
      chatsFound: chatsFound.length,
    });

    // Fetch all chats for this org
    const allChats = await telegramChatsRepository.findByOrganization(user.organization_id);

    return c.json({
      success: true,
      newChatsFound: chatsFound.length,
      chats: allChats.map((chat) => ({
        id: chat.chat_id.toString(),
        type: chat.chat_type,
        title: chat.title,
        username: chat.username,
        isAdmin: chat.is_admin,
        canPost: chat.can_post_messages,
      })),
    });
  } catch (error) {
    logger.error("[Telegram Scan] Failed to scan", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return failureResponse(c, error);
  }
});

export default app;
