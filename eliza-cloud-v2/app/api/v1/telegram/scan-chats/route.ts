import { NextRequest, NextResponse } from "next/server";
import { Telegraf } from "telegraf";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramAutomationService } from "@/lib/services/telegram-automation";
import { telegramChatsRepository } from "@/db/repositories/telegram-chats";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 30;

/**
 * GET /api/v1/telegram/scan-chats
 * Returns stored Telegram chats for the organization.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  try {
    const allChats = await telegramChatsRepository.findByOrganization(
      user.organization_id,
    );

    return NextResponse.json({
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
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return NextResponse.json(
      { error: "Failed to fetch chats" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/telegram/scan-chats
 * Scans for new chats via Telegram API and stores them.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const botToken = await telegramAutomationService.getBotToken(
    user.organization_id,
  );

  if (!botToken) {
    return NextResponse.json(
      { error: "Telegram bot not connected" },
      { status: 400 },
    );
  }

  const bot = new Telegraf(botToken);

  try {
    // Remove webhook temporarily to use getUpdates
    await bot.telegram.deleteWebhook({ drop_pending_updates: false });
    logger.info("[Telegram Scan] Webhook deleted, fetching updates...", {
      organizationId: user.organization_id,
    });

    // Get recent updates (includes my_chat_member events)
    const updates = await bot.telegram.getUpdates({
      allowed_updates: ["my_chat_member", "message", "channel_post"],
      limit: 100,
    });

    logger.info("[Telegram Scan] Got updates from Telegram", {
      organizationId: user.organization_id,
      updateCount: updates.length,
      updateTypes: updates.map((u) => {
        if (u.my_chat_member) return "my_chat_member";
        if (u.message) return "message";
        if (u.channel_post) return "channel_post";
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
      let chat: {
        id: number;
        title?: string;
        type: string;
        username?: string;
      } | null = null;

      if (update.my_chat_member) {
        chat = update.my_chat_member.chat as typeof chat;
      } else if (update.message?.chat) {
        chat = update.message.chat as typeof chat;
      } else if (update.channel_post?.chat) {
        chat = update.channel_post.chat as typeof chat;
      }

      if (
        chat &&
        !seenChatIds.has(chat.id) &&
        (chat.type === "group" ||
          chat.type === "supergroup" ||
          chat.type === "channel")
      ) {
        seenChatIds.add(chat.id);

        // Check bot's actual membership status
        let isAdmin = false;
        let canPost = false;
        try {
          const member = await bot.telegram.getChatMember(chat.id, botInfo.id);
          isAdmin =
            member.status === "administrator" || member.status === "creator";
          canPost =
            isAdmin || (member.status === "member" && chat.type !== "channel");
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
    const existingChats = await telegramChatsRepository.findByOrganization(
      user.organization_id,
    );
    for (const existingChat of existingChats) {
      if (!seenChatIds.has(existingChat.chat_id)) {
        try {
          const member = await bot.telegram.getChatMember(
            existingChat.chat_id,
            botInfo.id,
          );
          const isAdmin =
            member.status === "administrator" || member.status === "creator";
          const canPost =
            isAdmin ||
            (member.status === "member" &&
              existingChat.chat_type !== "channel");

          // Update if permissions changed
          if (
            existingChat.is_admin !== isAdmin ||
            existingChat.can_post_messages !== canPost
          ) {
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
    const webhookResult = await telegramAutomationService.setWebhook(
      user.organization_id,
    );
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
    const allChats = await telegramChatsRepository.findByOrganization(
      user.organization_id,
    );

    return NextResponse.json({
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
      organizationId: user.organization_id,
      error: error instanceof Error ? error.message : "Unknown error",
    });

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to scan for chats",
      },
      { status: 500 },
    );
  }
}
