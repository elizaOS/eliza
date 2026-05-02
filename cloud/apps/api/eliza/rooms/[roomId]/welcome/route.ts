/**
 * /api/eliza/rooms/:roomId/welcome
 *
 * POST: stores a "welcome" message as the first agent-authored message in
 * the room so the agent has context for its first reply.
 * DELETE: clears all messages (used when resetting edit-mode rooms).
 */

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { v4 as uuidv4 } from "uuid";
import { entitiesRepository, memoriesRepository } from "@/db/repositories";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { roomsService } from "@/lib/services/agents/rooms";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";
const ANON_SESSION_COOKIE = "eliza-anon-session";

async function resolveUserId(c: AppContext): Promise<string | null> {
  try {
    const u = await requireUserOrApiKey(c);
    return u.id;
  } catch {
    const token = getCookie(c, ANON_SESSION_COOKIE);
    if (!token) return null;
    const session = await anonymousSessionsService.getByToken(token);
    if (!session) return null;
    const user = await usersService.getById(session.user_id);
    if (!user || !user.is_anonymous) return null;
    return user.id;
  }
}

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const roomId = c.req.param("roomId") ?? "";
  const body = await c.req.json();
  const text = body?.text as string | undefined;

  if (!text?.trim()) return c.json({ error: "text is required" }, 400);

  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);

  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) return c.json({ error: "Access denied" }, 403);

  await entitiesRepository.create({
    id: DEFAULT_AGENT_ID,
    agentId: DEFAULT_AGENT_ID,
    names: ["Eliza"],
  });

  const messageId = uuidv4();
  const memory = await memoriesRepository.create({
    id: messageId,
    roomId,
    entityId: DEFAULT_AGENT_ID,
    agentId: DEFAULT_AGENT_ID,
    type: "messages",
    content: { text, source: "agent" },
  });

  logger.info(`[Welcome API] Stored welcome message: ${messageId} in room ${roomId}`);
  return c.json({ success: true, messageId: memory.id });
});

app.delete("/", async (c) => {
  const roomId = c.req.param("roomId") ?? "";
  const userId = await resolveUserId(c);
  if (!userId) return c.json({ error: "Authentication required" }, 401);

  const hasAccess = await roomsService.hasAccess(roomId, userId);
  if (!hasAccess) return c.json({ error: "Access denied" }, 403);

  await memoriesRepository.deleteMessages(roomId);
  logger.info(`[Welcome API] Cleared all messages from room ${roomId}`);
  return c.json({ success: true });
});

export default app;
