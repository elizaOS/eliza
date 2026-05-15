/**
 * /api/my-agents/characters
 * GET: Lists the authed user's own characters with search/filter/sort/pagination.
 * POST: Creates a new character for the authed user.
 *
 * Accepts both session and API-key auth so CLI/CI/CD callers and dashboards
 * can manage their fleet without browser cookies.
 */

import { Hono } from "hono";
import type { NewUserCharacter } from "@/db/repositories";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { charactersService } from "@/lib/services/characters/characters";
import { discordService } from "@/lib/services/discord";
import type { ElizaCharacter } from "@/lib/types";
import type { CategoryId, SortBy, SortOrder } from "@/lib/types/my-agents";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const search = c.req.query("search") || undefined;
    const category = c.req.query("category") as CategoryId | undefined;
    const sortBy = (c.req.query("sortBy") || "newest") as SortBy;
    const order = (c.req.query("order") || "desc") as SortOrder;
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const limit = Math.min(1000, Math.max(1, parseInt(c.req.query("limit") || "30", 10)));

    logger.debug("[My Agents API] Search request:", {
      userId: user.id,
      organizationId: user.organization_id,
      search,
      category,
      sortBy,
      page,
      limit,
    });

    let characters = await charactersService.listByUser(user.id);

    if (search) {
      const query = search.toLowerCase();
      characters = characters.filter(
        (char) =>
          char.name.toLowerCase().includes(query) ||
          (typeof char.bio === "string" && char.bio.toLowerCase().includes(query)) ||
          (Array.isArray(char.bio) && char.bio.some((b) => b.toLowerCase().includes(query))),
      );
    }
    if (category) {
      characters = characters.filter((char) => char.category === category);
    }

    characters.sort((a, b) => {
      switch (sortBy) {
        case "name": {
          const result = a.name.localeCompare(b.name);
          return order === "desc" ? -result : result;
        }
        case "newest": {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          return order === "desc" ? dateB - dateA : dateA - dateB;
        }
        case "updated": {
          const updA = a.updated_at ? new Date(a.updated_at).getTime() : 0;
          const updB = b.updated_at ? new Date(b.updated_at).getTime() : 0;
          return order === "desc" ? updB - updA : updA - updB;
        }
        default:
          return 0;
      }
    });

    const totalCount = characters.length;
    const totalPages = Math.ceil(totalCount / limit);
    const offset = (page - 1) * limit;
    const paginatedCharacters = characters.slice(offset, offset + limit);

    return c.json({
      success: true,
      data: {
        characters: paginatedCharacters.map((char) => ({
          id: char.id,
          name: char.name,
          bio: char.bio,
          avatarUrl: char.avatar_url,
          avatar_url: char.avatar_url,
          category: char.category,
          isPublic: char.is_public,
          is_public: char.is_public,
          createdAt: char.created_at,
          created_at: char.created_at,
          updatedAt: char.updated_at,
          updated_at: char.updated_at,
          tags: char.tags,
          token_address: char.token_address ?? null,
          token_chain: char.token_chain ?? null,
          token_name: char.token_name ?? null,
          token_ticker: char.token_ticker ?? null,
        })),
        pagination: {
          page,
          limit,
          totalPages,
          totalCount,
          hasMore: page < totalPages,
        },
      },
    });
  } catch (error) {
    logger.error("[My Agents API] Error searching characters:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const elizaCharacter = (await c.req.json()) as ElizaCharacter;
    const documentSources = [
      ...(elizaCharacter.documents ?? []),
      ...(elizaCharacter.knowledge ?? []),
    ];

    // Normalize isPublic to ensure consistency between is_public column and character_data
    const isPublic = typeof elizaCharacter.isPublic === "boolean" ? elizaCharacter.isPublic : false;

    const characterDataRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(elizaCharacter)) {
      characterDataRecord[key] = value;
    }
    characterDataRecord.documents = documentSources;
    characterDataRecord.isPublic = isPublic;

    const newCharacter: NewUserCharacter = {
      organization_id: user.organization_id,
      user_id: user.id,
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
      is_template: false,
      is_public: isPublic,
      source: "cloud",
    };

    const character = await charactersService.create(newCharacter);

    discordService
      .logCharacterCreated({
        characterId: character.id,
        characterName: character.name,
        userName: user.email || null,
        userId: user.id,
        organizationName: user.organization.name ?? "",
        bio: Array.isArray(elizaCharacter.bio) ? elizaCharacter.bio.join(" ") : elizaCharacter.bio,
        plugins: elizaCharacter.plugins,
      })
      .catch((error) => {
        logger.error("[CharacterCreate] Failed to log to Discord:", error);
      });

    return c.json(charactersService.toElizaCharacter(character));
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
