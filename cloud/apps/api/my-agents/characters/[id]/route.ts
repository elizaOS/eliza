/**
 * /api/my-agents/characters/:id
 * GET: fetch one of the authed user's characters by id.
 * PUT: update one of the authed user's characters by id.
 * DELETE: hard-delete after ownership check.
 */

import { Hono } from "hono";
import type { NewUserCharacter } from "@/db/repositories";
import { failureResponse, NotFoundError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import type { ElizaCharacter } from "@/lib/types";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return c.json({ success: false, error: "Character not found" }, 404);
    }
    return c.json({
      success: true,
      data: { character: charactersService.toElizaCharacter(character) },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.put("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";
    const elizaCharacter = (await c.req.json()) as ElizaCharacter;
    const documentSources = [
      ...(elizaCharacter.documents ?? []),
      ...(elizaCharacter.knowledge ?? []),
    ];

    const characterDataRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(elizaCharacter)) {
      characterDataRecord[key] = value;
    }
    characterDataRecord.documents = documentSources;

    const updates: Partial<NewUserCharacter> = {
      name: elizaCharacter.name,
      username: elizaCharacter.username ?? null,
      system: elizaCharacter.system ?? null,
      bio: elizaCharacter.bio,
      message_examples: (elizaCharacter.messageExamples ?? []) as Record<string, unknown>[][],
      post_examples: elizaCharacter.postExamples ?? [],
      topics: elizaCharacter.topics ?? [],
      adjectives: elizaCharacter.adjectives ?? [],
      knowledge: documentSources,
      plugins: elizaCharacter.plugins ?? [],
      settings: elizaCharacter.settings ?? {},
      secrets: elizaCharacter.secrets ?? {},
      style: elizaCharacter.style ?? {},
      character_data: characterDataRecord,
      avatar_url: elizaCharacter.avatarUrl ?? null,
    };

    const character = await charactersService.updateForUser(id, user.id, updates);
    if (!character) throw NotFoundError("Character not found or access denied");

    return c.json(charactersService.toElizaCharacter(character));
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id") ?? "";

    logger.info("[My Agents API] Deleting character:", {
      characterId: id,
      userId: user.id,
    });

    const character = await charactersService.getByIdForUser(id, user.id);
    if (!character) {
      return c.json({ success: false, error: "Character not found or access denied" }, 404);
    }

    await charactersService.delete(id);
    // TODO(cache): /dashboard + /dashboard/my-agents revalidation dropped
    // (no Workers-side equivalent of next/cache revalidatePath).
    return c.json({ success: true, data: { message: "Character deleted successfully" } });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
