/**
 * GET /api/my-agents/characters/:id/stats
 * Returns view/interaction/message counts for the authed user's character.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { dbRead } from "@/db/client";
import { memoryTable } from "@/db/schemas/eliza";
import { elizaRoomCharactersTable } from "@/db/schemas/eliza-room-characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    if (!uuidPattern.test(id)) {
      return c.json({ success: false, error: "Invalid character id" }, 400);
    }
    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return c.json({ success: false, error: "Character not found" }, 404);
    }

    const roomRows = await dbRead
      .select({ roomId: elizaRoomCharactersTable.room_id })
      .from(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.character_id, id));

    const roomIds = roomRows.map((row) => row.roomId);
    let messageCount = 0;
    let lastActiveAt: string | null = null;

    if (roomIds.length > 0) {
      const [messageStats] = await dbRead
        .select({
          messageCount: sql<number>`count(*)`,
          lastActiveAt: sql<Date | string | null>`max(${memoryTable.createdAt})`,
        })
        .from(memoryTable)
        .where(and(inArray(memoryTable.roomId, roomIds), eq(memoryTable.type, "messages")));

      messageCount = Number(messageStats?.messageCount ?? 0);
      lastActiveAt = messageStats?.lastActiveAt
        ? new Date(messageStats.lastActiveAt).toISOString()
        : null;
    }

    const stats = {
      views: character.view_count,
      interactions: character.interaction_count,
      messageCount,
      roomCount: roomIds.length,
      lastActiveAt,
      totalInferenceRequests: character.total_inference_requests,
    };

    return c.json({ success: true, data: { stats } });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
