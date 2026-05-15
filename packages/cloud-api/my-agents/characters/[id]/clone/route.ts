/**
 * POST /api/my-agents/characters/:id/clone
 *
 * Clones a character into the authed user's namespace. Optional body:
 * `{ name?, username?, makePublic? }`. Username defaults to an auto-generated
 * derivative when omitted.
 */

import { Hono } from "hono";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";

    let body: { name?: string; username?: string; makePublic?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine.
    }

    logger.info("[My Agents API] Cloning character:", {
      characterId: id,
      userId: user.id,
      name: body.name,
      username: body.username,
    });

    const original = await charactersService.getById(id);
    if (!original) {
      return c.json({ success: false, error: "Character not found" }, 404);
    }

    const cloneName = body.name || `${original.name} (Copy)`;

    const clonedCharacter = await charactersService.create({
      user_id: user.id,
      organization_id: user.organization_id,
      name: cloneName,
      username: body.username,
      bio: original.bio,
      system: original.system,
      topics: original.topics,
      adjectives: original.adjectives,
      knowledge: original.knowledge,
      plugins: original.plugins,
      style: original.style,
      settings: original.settings,
      character_data: original.character_data || {},
      avatar_url: original.avatar_url,
      category: original.category,
      tags: original.tags,
      is_public: body.makePublic ?? false,
      is_template: false,
    });

    logger.info("[My Agents API] Character cloned successfully:", {
      originalId: id,
      clonedId: clonedCharacter.id,
      clonedUsername: clonedCharacter.username,
    });

    return c.json({
      success: true,
      data: { character: clonedCharacter, message: "Character cloned successfully" },
    });
  } catch (error) {
    logger.error("[My Agents API] Error cloning character:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to clone character";
    const isValidationError =
      errorMessage.includes("username") || errorMessage.includes("Username");
    const status: 400 | 404 | 500 = isValidationError
      ? 400
      : error instanceof Error && error.message.includes("not found")
        ? 404
        : 500;
    return c.json({ success: false, error: errorMessage }, status);
  }
});

export default app;
