import { and, asc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  type DiscordChannel,
  discordChannels,
  type NewDiscordChannel,
} from "@/db/schemas/discord-channels";

class DiscordChannelsRepository {
  async findByGuild(organizationId: string, guildId: string): Promise<DiscordChannel[]> {
    return dbRead
      .select()
      .from(discordChannels)
      .where(
        and(
          eq(discordChannels.organization_id, organizationId),
          eq(discordChannels.guild_id, guildId),
        ),
      )
      .orderBy(asc(discordChannels.position));
  }

  async findByChannelId(
    organizationId: string,
    channelId: string,
  ): Promise<DiscordChannel | undefined> {
    const results = await dbRead
      .select()
      .from(discordChannels)
      .where(
        and(
          eq(discordChannels.organization_id, organizationId),
          eq(discordChannels.channel_id, channelId),
        ),
      )
      .limit(1);
    return results[0];
  }

  async findSendableByGuild(organizationId: string, guildId: string): Promise<DiscordChannel[]> {
    return dbRead
      .select()
      .from(discordChannels)
      .where(
        and(
          eq(discordChannels.organization_id, organizationId),
          eq(discordChannels.guild_id, guildId),
          eq(discordChannels.can_send_messages, true),
        ),
      )
      .orderBy(asc(discordChannels.position));
  }

  async upsert(
    data: Omit<NewDiscordChannel, "id" | "created_at" | "updated_at">,
  ): Promise<DiscordChannel> {
    const existing = await this.findByChannelId(data.organization_id, data.channel_id);

    if (existing) {
      const [updated] = await dbWrite
        .update(discordChannels)
        .set({
          channel_name: data.channel_name,
          channel_type: data.channel_type,
          parent_id: data.parent_id,
          position: data.position,
          can_send_messages: data.can_send_messages,
          can_embed_links: data.can_embed_links,
          can_attach_files: data.can_attach_files,
          is_nsfw: data.is_nsfw,
          updated_at: new Date(),
        })
        .where(eq(discordChannels.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await dbWrite.insert(discordChannels).values(data).returning();
    return created;
  }

  async delete(organizationId: string, channelId: string): Promise<void> {
    await dbWrite
      .delete(discordChannels)
      .where(
        and(
          eq(discordChannels.organization_id, organizationId),
          eq(discordChannels.channel_id, channelId),
        ),
      );
  }

  async deleteByGuild(organizationId: string, guildId: string): Promise<void> {
    await dbWrite
      .delete(discordChannels)
      .where(
        and(
          eq(discordChannels.organization_id, organizationId),
          eq(discordChannels.guild_id, guildId),
        ),
      );
  }

  async deleteByOrganization(organizationId: string): Promise<void> {
    await dbWrite
      .delete(discordChannels)
      .where(eq(discordChannels.organization_id, organizationId));
  }
}

export const discordChannelsRepository = new DiscordChannelsRepository();
