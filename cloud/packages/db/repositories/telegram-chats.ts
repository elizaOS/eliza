import { and, desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  type NewTelegramChat,
  type TelegramChat,
  telegramChats,
} from "@/db/schemas/telegram-chats";

class TelegramChatsRepository {
  async findByOrganization(organizationId: string): Promise<TelegramChat[]> {
    return dbRead
      .select()
      .from(telegramChats)
      .where(eq(telegramChats.organization_id, organizationId))
      .orderBy(desc(telegramChats.created_at));
  }

  async findByChatId(organizationId: string, chatId: number): Promise<TelegramChat | undefined> {
    const results = await dbRead
      .select()
      .from(telegramChats)
      .where(
        and(eq(telegramChats.organization_id, organizationId), eq(telegramChats.chat_id, chatId)),
      )
      .limit(1);
    return results[0];
  }

  async upsert(data: NewTelegramChat): Promise<TelegramChat> {
    const existing = await this.findByChatId(data.organization_id, data.chat_id);

    if (existing) {
      const [updated] = await dbWrite
        .update(telegramChats)
        .set({
          title: data.title,
          username: data.username,
          chat_type: data.chat_type,
          is_admin: data.is_admin,
          can_post_messages: data.can_post_messages,
          updated_at: new Date(),
        })
        .where(eq(telegramChats.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await dbWrite.insert(telegramChats).values(data).returning();
    return created;
  }

  async delete(organizationId: string, chatId: number): Promise<void> {
    await dbWrite
      .delete(telegramChats)
      .where(
        and(eq(telegramChats.organization_id, organizationId), eq(telegramChats.chat_id, chatId)),
      );
  }

  async deleteByOrganization(organizationId: string): Promise<void> {
    await dbWrite.delete(telegramChats).where(eq(telegramChats.organization_id, organizationId));
  }
}

export const telegramChatsRepository = new TelegramChatsRepository();
