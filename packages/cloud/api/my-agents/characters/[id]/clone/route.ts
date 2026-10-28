/**
 * POST /api/my-agents/characters/:id/clone
 *
 * Clones a character into the authed user's namespace. Optional body:
 * `{ name?, username?, makePublic? }`. Username defaults to an auto-generated
 * derivative when omitted.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { charactersService } from "@elizaos/cloud-shared/lib/services/characters";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

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

    // SECURITY: charactersService.getById is NOT org/visibility-scoped, so gate
    // clonability — a caller may only clone a character they own, or one that is
    // public/template. Otherwise any authenticated user could clone (and read
    // back) another org's PRIVATE character config (system prompt, knowledge,
    // settings) — cross-tenant IP disclosure. 404 (not 403) to avoid an
    // existence oracle. Mirrors the app-link route's guard. A creator who left
    // the character's organization no longer owns it.
    const ownsOriginal =
      original.user_id === user.id &&
      original.organization_id === user.organization_id;
    if (!ownsOriginal && !original.is_public && !original.is_template) {
      return c.json({ success: false, error: "Character not found" }, 404);
    }

    const cloneName = body.name || `${original.name} (Copy)`;
    // A public or template character can be cloned by anyone, but its
    // secrets (API keys, connector tokens) belong to its owner: only the
    // owner's own clone keeps them.
    // Removes every `secrets` key, at any depth (plugin and provider config
    // nests its own). Values that are not objects are kept as they are.
    const withoutSecrets = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutSecrets);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "secrets")
          .map(([key, entry]) => [key, withoutSecrets(entry)]),
      );
    };
    const settings = ownsOriginal
      ? original.settings
      : (withoutSecrets(original.settings) as typeof original.settings);
    const characterData = ownsOriginal
      ? original.character_data || {}
      : ((withoutSecrets(original.character_data) ??
          {}) as typeof original.character_data);

    const clonedCharacter = await charactersService.create(
      {
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
        message_examples: original.message_examples,
        post_examples: original.post_examples,
        secrets: ownsOriginal ? original.secrets : {},
        settings,
        character_data: characterData,
        avatar_url: original.avatar_url,
        category: original.category,
        tags: original.tags,
        is_public: body.makePublic ?? false,
        is_template: false,
      },
      { policy: { mode: "metered" } },
    );

    logger.info("[My Agents API] Character cloned successfully:", {
      originalId: id,
      clonedId: clonedCharacter.id,
      clonedUsername: clonedCharacter.username,
    });

    return c.json({
      success: true,
      data: {
        character: clonedCharacter,
        message: "Character cloned successfully",
      },
    });
  } catch (error) {
    logger.error("[My Agents API] Error cloning character:", error);
    return failureResponse(c, error);
  }
});

export default app;
