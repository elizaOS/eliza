import { and, eq, inArray, sql } from "drizzle-orm";
import { dbRead } from "../helpers";
import { containers } from "../schemas/containers";
import { memoryTable } from "../schemas/eliza";
import { elizaRoomCharactersTable } from "../schemas/eliza-room-characters";
import { type UserCharacter, userCharacters } from "../schemas/user-characters";
import { users } from "../schemas/users";

const DASHBOARD_AGENT_LIMIT = 200;

export type DashboardDeploymentStatus = "deployed" | "stopped" | "draft";

export interface DashboardAgentStats {
  roomCount: number;
  messageCount: number;
  lastActiveAt: string | null;
  status: DashboardDeploymentStatus;
  deploymentStatus: DashboardDeploymentStatus;
}

export interface DashboardAgent {
  id: string;
  name: string;
  bio: string | string[];
  avatarUrl: string | null;
  category: string | null;
  isPublic: boolean;
  username: string | null;
  stats?: DashboardAgentStats;
}

export interface DashboardSummary {
  user: { name: string };
  agents: DashboardAgent[];
}

type DashboardContainerRow = typeof containers.$inferSelect;

export class DashboardRepository {
  async getSummaryForUser(userId: string): Promise<DashboardSummary> {
    const [userRows, characterRows] = await Promise.all([
      dbRead
        .select({ name: users.name, nickname: users.nickname })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      dbRead
        .select()
        .from(userCharacters)
        .where(eq(userCharacters.user_id, userId))
        .limit(DASHBOARD_AGENT_LIMIT),
    ]);

    const userRecord = userRows[0];
    const displayName = userRecord?.name ?? userRecord?.nickname ?? "User";
    const characterIds = characterRows.map((character: UserCharacter) => character.id);
    const statsMap = await this.loadAgentStats(characterIds);

    return {
      user: { name: displayName },
      agents: characterRows.map((character: UserCharacter) => {
        const stats = statsMap.get(character.id);
        return {
          id: character.id,
          name: character.name,
          bio: character.bio,
          avatarUrl: character.avatar_url ?? null,
          category: character.category ?? null,
          isPublic: character.is_public,
          username: character.username ?? null,
          ...(stats ? { stats } : {}),
        };
      }),
    };
  }

  private async loadAgentStats(characterIds: string[]): Promise<Map<string, DashboardAgentStats>> {
    const statsMap = new Map<string, DashboardAgentStats>();
    if (characterIds.length === 0) return statsMap;

    const [containerRows, roomCharacterRows] = await Promise.all([
      dbRead.select().from(containers).where(inArray(containers.character_id, characterIds)),
      dbRead
        .select()
        .from(elizaRoomCharactersTable)
        .where(inArray(elizaRoomCharactersTable.character_id, characterIds)),
    ]);

    const containerByCharacter = new Map<string, DashboardContainerRow>();
    for (const row of containerRows) {
      if (!row.character_id) continue;
      const existing = containerByCharacter.get(row.character_id);
      if (!existing || row.status === "running") {
        containerByCharacter.set(row.character_id, row);
      }
    }

    const roomsByCharacter = new Map<string, string[]>();
    const characterByRoom = new Map<string, string>();
    for (const row of roomCharacterRows) {
      const list = roomsByCharacter.get(row.character_id) ?? [];
      list.push(row.room_id);
      roomsByCharacter.set(row.character_id, list);
      characterByRoom.set(row.room_id, row.character_id);
    }

    const allRoomIds = [...characterByRoom.keys()];
    const messageStatsByCharacter = new Map<
      string,
      { messageCount: number; lastActiveAt: Date | null }
    >();

    if (allRoomIds.length > 0) {
      const groupedRows = await dbRead
        .select({
          roomId: memoryTable.roomId,
          messageCount: sql<number>`count(*)`,
          lastActiveAt: sql<Date | null>`max(${memoryTable.createdAt})`,
        })
        .from(memoryTable)
        .where(and(inArray(memoryTable.roomId, allRoomIds), eq(memoryTable.type, "messages")))
        .groupBy(memoryTable.roomId);

      for (const row of groupedRows) {
        if (!row.roomId) continue;
        const characterId = characterByRoom.get(row.roomId);
        if (!characterId) continue;
        const current = messageStatsByCharacter.get(characterId) ?? {
          messageCount: 0,
          lastActiveAt: null as Date | null,
        };
        current.messageCount += Number(row.messageCount);
        if (
          row.lastActiveAt &&
          (!current.lastActiveAt || row.lastActiveAt > current.lastActiveAt)
        ) {
          current.lastActiveAt = row.lastActiveAt;
        }
        messageStatsByCharacter.set(characterId, current);
      }
    }

    for (const characterId of characterIds) {
      const rooms = roomsByCharacter.get(characterId);
      const roomCount = rooms ? rooms.length : 0;
      const container = containerByCharacter.get(characterId);
      const msgStats = messageStatsByCharacter.get(characterId) ?? {
        messageCount: 0,
        lastActiveAt: null as Date | null,
      };

      if (!container && roomCount === 0 && msgStats.messageCount === 0) {
        continue;
      }

      const status: DashboardDeploymentStatus = container
        ? container.status === "running"
          ? "deployed"
          : "stopped"
        : "draft";

      statsMap.set(characterId, {
        roomCount,
        messageCount: msgStats.messageCount,
        lastActiveAt: msgStats.lastActiveAt ? msgStats.lastActiveAt.toISOString() : null,
        status,
        deploymentStatus: status,
      });
    }

    return statsMap;
  }
}

export const dashboardRepository = new DashboardRepository();
