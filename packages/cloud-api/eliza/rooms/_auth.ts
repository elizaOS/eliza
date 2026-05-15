import { getCookie } from "hono/cookie";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { anonymousSessionsService } from "@/lib/services/anonymous-sessions";
import { usersService } from "@/lib/services/users";
import type { AppContext } from "@/types/cloud-worker-env";

export const DEFAULT_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";

const ANON_SESSION_COOKIE = "eliza-anon-session";

export async function resolveRoomUserId(
  c: AppContext,
  explicitSessionToken?: string,
): Promise<string | null> {
  try {
    const user = await requireUserOrApiKey(c);
    return user.id;
  } catch {
    const token =
      explicitSessionToken?.trim() ||
      c.req.header("X-Anonymous-Session")?.trim() ||
      getCookie(c, ANON_SESSION_COOKIE);
    if (!token) return null;

    const session = await anonymousSessionsService.getByToken(token);
    if (!session) return null;
    const user = await usersService.getById(session.user_id);
    return user?.is_anonymous ? user.id : null;
  }
}
