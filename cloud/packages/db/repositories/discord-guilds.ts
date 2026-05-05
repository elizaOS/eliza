import { and, desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
  type DiscordGuild,
  discordGuilds,
  type NewDiscordGuild,
} from "@/db/schemas/discord-guilds";

class DiscordGuildsRepository {
  async findByOrganization(organizationId: string): Promise<DiscordGuild[]> {
    return dbRead
      .select()
      .from(discordGuilds)
      .where(
        and(eq(discordGuilds.organization_id, organizationId), eq(discordGuilds.is_active, true)),
      )
      .orderBy(desc(discordGuilds.bot_joined_at));
  }

  async findByGuildId(organizationId: string, guildId: string): Promise<DiscordGuild | undefined> {
    const results = await dbRead
      .select()
      .from(discordGuilds)
      .where(
        and(eq(discordGuilds.organization_id, organizationId), eq(discordGuilds.guild_id, guildId)),
      )
      .limit(1);
    return results[0];
  }

  async upsert(
    data: Omit<NewDiscordGuild, "id" | "created_at" | "updated_at">,
  ): Promise<DiscordGuild> {
    const existing = await this.findByGuildId(data.organization_id, data.guild_id);

    if (existing) {
      const [updated] = await dbWrite
        .update(discordGuilds)
        .set({
          guild_name: data.guild_name,
          icon_hash: data.icon_hash,
          owner_id: data.owner_id,
          bot_permissions: data.bot_permissions,
          is_active: true,
          updated_at: new Date(),
        })
        .where(eq(discordGuilds.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await dbWrite.insert(discordGuilds).values(data).returning();
    return created;
  }

  async delete(organizationId: string, guildId: string): Promise<void> {
    await dbWrite
      .delete(discordGuilds)
      .where(
        and(eq(discordGuilds.organization_id, organizationId), eq(discordGuilds.guild_id, guildId)),
      );
  }

  async softDelete(organizationId: string, guildId: string): Promise<void> {
    await dbWrite
      .update(discordGuilds)
      .set({
        is_active: false,
        updated_at: new Date(),
      })
      .where(
        and(eq(discordGuilds.organization_id, organizationId), eq(discordGuilds.guild_id, guildId)),
      );
  }

  async deleteByOrganization(organizationId: string): Promise<void> {
    await dbWrite.delete(discordGuilds).where(eq(discordGuilds.organization_id, organizationId));
  }
}

export const discordGuildsRepository = new DiscordGuildsRepository();
