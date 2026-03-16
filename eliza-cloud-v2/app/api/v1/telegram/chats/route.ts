import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { telegramChatsRepository } from "@/db/repositories/telegram-chats";

export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const chats = await telegramChatsRepository.findByOrganization(
    user.organization_id,
  );

  return NextResponse.json({
    chats: chats.map((chat) => ({
      id: chat.chat_id.toString(),
      type: chat.chat_type,
      title: chat.title,
      username: chat.username,
      isAdmin: chat.is_admin,
      canPost: chat.can_post_messages,
    })),
  });
}
