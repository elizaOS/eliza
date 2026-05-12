/**
 * /api/my-agents/characters/:id/share
 *
 * GET: returns the current `is_public` flag + share URL.
 * PUT: toggles `is_public`. Lighter than /publish (no monetization).
 *
 * Privacy:
 *   - Character secrets are never exposed publicly.
 *   - Only "shared" knowledge items are accessible.
 *   - Billing is per-chatter, not the character owner.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const ShareSchema = z.object({ isPublic: z.boolean() });

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return c.json({ success: false, error: "Character not found" }, 404);
    }

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
    return c.json({
      success: true,
      data: {
        isPublic: character.is_public,
        shareUrl: character.is_public ? `${baseUrl}/chat/${character.id}` : null,
        shareInfo: character.is_public
          ? {
              chatUrl: `${baseUrl}/chat/${character.id}`,
              dashboardChatUrl: `${baseUrl}/dashboard/chat?characterId=${character.id}`,
              a2aEndpoint: `${baseUrl}/api/agents/${character.id}/a2a`,
              mcpEndpoint: `${baseUrl}/api/agents/${character.id}/mcp`,
            }
          : null,
      },
    });
  } catch (error) {
    logger.error("[Share API] Error getting share status:", error);
    return c.json({ success: false, error: "Failed to get share status" }, 500);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";

    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return c.json({ success: false, error: "Character not found or access denied" }, 404);
    }

    const body = await c.req.json();
    const validation = ShareSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { success: false, error: "Invalid request body", details: validation.error.issues },
        400,
      );
    }

    const { isPublic } = validation.data;
    logger.info("[Share API] Toggling character share status:", {
      characterId: id,
      userId: user.id,
      characterName: character.name,
      previousStatus: character.is_public,
      newStatus: isPublic,
    });

    const updated = await charactersService.update(id, { is_public: isPublic });
    if (!updated) {
      return c.json({ success: false, error: "Failed to update character" }, 500);
    }

    // TODO(cache): /dashboard and /dashboard/my-agents revalidation
    // dropped — no Workers-side equivalent of next/cache revalidatePath.

    const baseUrl = c.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
    return c.json({
      success: true,
      data: {
        characterId: id,
        characterName: updated.name,
        isPublic: updated.is_public,
        shareUrl: updated.is_public ? `${baseUrl}/chat/${updated.id}` : null,
        message: updated.is_public
          ? `"${updated.name}" is now publicly shareable! Anyone with the link can chat with this character.`
          : `"${updated.name}" is now private. Only you can chat with this character.`,
        shareInfo: updated.is_public
          ? {
              chatUrl: `${baseUrl}/chat/${updated.id}`,
              dashboardChatUrl: `${baseUrl}/dashboard/chat?characterId=${updated.id}`,
            }
          : null,
      },
    });
  } catch (error) {
    logger.error("[Share API] Error toggling share status:", error);
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update share status",
      },
      500,
    );
  }
});

export default app;
