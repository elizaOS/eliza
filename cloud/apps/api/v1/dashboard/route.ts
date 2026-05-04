/**
 * GET /api/v1/dashboard
 *
 * Aggregated payload for the SPA's dashboard home page
 * (`apps/frontend/src/dashboard/Page.tsx`).
 *
 * The SPA's `AgentsSection` reads `user.name` and `agents[]`, where each
 * agent may carry a `stats` object (`roomCount`, `messageCount`,
 * `lastActiveAt`, `deploymentStatus`). We compute those inline against the
 * same Postgres the runtime writes to:
 *   - rooms: `eliza_room_characters.character_id = X`
 *   - messages: `memories` joined on `room_id` where `type = 'messages'`
 *   - deployment: `containers.status` for `containers.character_id = X`
 *
 * Stats stay optional on the response — `AgentsSection` already treats
 * them that way, and we omit the field for agents that have never had a
 * room or container row attached.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "@/db/worker-neon-http";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AppEnv } from "@/types/cloud-worker-env";
import { containers } from "../../../../packages/db/schemas/containers";
import { memoryTable } from "../../../../packages/db/schemas/eliza";
import { elizaRoomCharactersTable } from "../../../../packages/db/schemas/eliza-room-characters";
import { userCharacters } from "../../../../packages/db/schemas/user-characters";
import { users } from "../../../../packages/db/schemas/users";

type UserCharacterRow = typeof userCharacters.$inferSelect;
type ContainerRow = typeof containers.$inferSelect;

const DASHBOARD_AGENT_LIMIT = 200;

type DeploymentStatus = "deployed" | "stopped" | "draft";

interface DashboardAgentStats {
  roomCount: number;
  messageCount: number;
  lastActiveAt: string | null;
  status: DeploymentStatus;
  deploymentStatus: DeploymentStatus;
}

interface DashboardAgent {
  id: string;
  name: string;
  bio: string | string[];
  avatarUrl: string | null;
  category: string | null;
  isPublic: boolean;
  username: string | null;
  stats?: DashboardAgentStats;
}

interface DashboardResponse {
  success: true;
  user: { name: string };
  agents: DashboardAgent[];
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const authed = await requireUserOrApiKeyWithOrg(c);
    const db = getDb(c);

    const [userRows, characterRows] = await Promise.all([
      db
        .select({ name: users.name, nickname: users.nickname })
        .from(users)
        .where(eq(users.id, authed.id))
        .limit(1),
      db
        .select()
        .from(userCharacters)
        .where(eq(userCharacters.user_id, authed.id))
        .limit(DASHBOARD_AGENT_LIMIT),
    ]);

    const userRecord = userRows[0];
    const displayName = userRecord?.name ?? userRecord?.nickname ?? "User";

    const characterIds = characterRows.map((c: UserCharacterRow) => c.id);

    const statsMap = await loadAgentStats(db, characterIds);

    const agents: DashboardAgent[] = characterRows.map((c: UserCharacterRow) => {
      const stats = statsMap.get(c.id);
      return {
        id: c.id,
        name: c.name,
        bio: c.bio,
        avatarUrl: c.avatar_url ?? null,
        category: c.category ?? null,
        isPublic: c.is_public,
        username: c.username ?? null,
        ...(stats ? { stats } : {}),
      };
    });

    const body: DashboardResponse = {
      success: true,
      user: { name: displayName },
      agents,
    };

    return c.json(body);
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;

/**
 * Computes per-character stats in three batched queries: containers,
 * room→character mapping, and a single grouped aggregate over all
 * relevant memory rows (count + max(createdAt) bucketed by roomId).
 *
 * Returns a map keyed by character ID. Characters with no rooms and no
 * container row are omitted so the route can drop the `stats` field
 * entirely for "never deployed, never chatted with" agents.
 */
async function loadAgentStats(
  db: ReturnType<typeof getDb>,
  characterIds: string[],
): Promise<Map<string, DashboardAgentStats>> {
  const statsMap = new Map<string, DashboardAgentStats>();
  if (characterIds.length === 0) return statsMap;

  const [containerRows, roomCharacterRows] = await Promise.all([
    db.select().from(containers).where(inArray(containers.character_id, characterIds)),
    db
      .select()
      .from(elizaRoomCharactersTable)
      .where(inArray(elizaRoomCharactersTable.character_id, characterIds)),
  ]);

  const containerByCharacter = new Map<string, ContainerRow>();
  for (const row of containerRows) {
    if (!row.character_id) continue;
    // Prefer a running container if one exists; otherwise keep whichever was seen first.
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

  // Single grouped aggregate across every relevant room. The rooms table's
  // `agentId` column is the elizaOS agent UUID (not the character ID), so we
  // filter by `roomId` and bucket the count/lastActiveAt back to the owning
  // character via `characterByRoom`.
  const allRoomIds = [...characterByRoom.keys()];
  const messageStatsByCharacter = new Map<
    string,
    { messageCount: number; lastActiveAt: Date | null }
  >();
  if (allRoomIds.length > 0) {
    const groupedRows = await db
      .select({
        roomId: memoryTable.roomId,
        messageCount: sql<number>`count(*)`,
        lastActiveAt: sql<Date | null>`max(${memoryTable.createdAt})`,
      })
      .from(memoryTable)
      .where(and(inArray(memoryTable.roomId, allRoomIds), eq(memoryTable.type, "messages")))
      .groupBy(memoryTable.roomId);

    for (const row of groupedRows) {
      const characterId = characterByRoom.get(row.roomId);
      if (!characterId) continue;
      const current = messageStatsByCharacter.get(characterId) ?? {
        messageCount: 0,
        lastActiveAt: null as Date | null,
      };
      current.messageCount += Number(row.messageCount);
      if (row.lastActiveAt && (!current.lastActiveAt || row.lastActiveAt > current.lastActiveAt)) {
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
      // No deployment row, no rooms, no messages — surface no stats so the
      // SPA renders the bare card.
      continue;
    }

    const status: DeploymentStatus = container
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
