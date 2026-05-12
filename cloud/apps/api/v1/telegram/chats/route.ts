import { Hono } from "hono";
import { telegramChatsRepository } from "@/db/repositories/telegram-chats";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const chats = await telegramChatsRepository.findByOrganization(user.organization_id);

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
