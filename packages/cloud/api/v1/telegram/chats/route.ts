// Handles v1 cloud API v1 telegram chats route traffic with route-local auth expectations.

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { telegramChatsRepository } from "@elizaos/cloud-shared/db/repositories/telegram-chats";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const chats = await telegramChatsRepository.findByOrganization(
      user.organization_id,
    );

    return c.json({
      chats: chats.map((chat) => ({
        id: chat.chat_id.toString(),
        type: chat.chat_type,
        title: chat.title,
        username: chat.username,
        isAdmin: chat.is_admin,
        canPost: chat.can_post_messages,
      })),
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
