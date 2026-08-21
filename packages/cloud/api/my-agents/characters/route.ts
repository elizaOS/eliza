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
import { userCharactersRepository } from "@/db/repositories/characters";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { isCategoryId } from "@/lib/constants/character-categories";
import { charactersService } from "@/lib/services/characters/characters";
import { discordService } from "@/lib/services/discord";
import type { ElizaCharacter } from "@/lib/types";
import type { CategoryId, SortBy, SortOrder } from "@/lib/types/my-agents";
import { parseClampedLimit } from "@/lib/utils/clamp-limit";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const search = c.req.query("search") || undefined;
    const rawCategory = c.req.query("category");
    if (
      rawCategory !== undefined &&
      rawCategory !== "" &&
      !isCategoryId(rawCategory)
    ) {
      return c.json({ error: "Invalid category" }, 400);
    }
    const category: CategoryId | undefined = rawCategory || undefined;
    // Catalog-sort identity, not leftover database-rows page tax. Unknown
    // sortBy used to fall through the repository switch onto popularity_score
    // while the route advertised a newest default. Unknown order silently
    // became desc. Canonical tokens only; omitted/empty keep today's defaults.
    const rawSortBy = c.req.query("sortBy");
    const rawOrder = c.req.query("order");
    const allowedSortBy = new Set(["newest", "popularity", "name", "updated"]);
    const allowedOrder = new Set(["asc", "desc"]);
    if (
      rawSortBy !== undefined &&
      rawSortBy !== "" &&
      !allowedSortBy.has(rawSortBy)
    ) {
      return c.json({ error: "Invalid sortBy" }, 400);
    }
    if (
      rawOrder !== undefined &&
      rawOrder !== "" &&
      !allowedOrder.has(rawOrder)
    ) {
      return c.json({ error: "Invalid order" }, 400);
    }
    const sortBy = (rawSortBy || "newest") as SortBy;
    const order = (rawOrder || "desc") as SortOrder;
    const limit = parseClampedLimit(c.req.query("limit"), 30, 1000);
    const maxPage = Math.floor(Number.MAX_SAFE_INTEGER / limit) + 1;
    const page = parseClampedLimit(c.req.query("page"), 1, maxPage);

    logger.debug("[My Agents API] Search request:", {
      userId: user.id,
      organizationId: user.organization_id,
      search,
      category,
      sortBy,
      page,
      limit,
    });

    const offset = (page - 1) * limit;
    const filters = { search, category, source: "cloud" as const };
    // my-agents listing sorted only by the requested field — not featured-first
    // (unlike marketplace/public search). See elizaOS/eliza#18339 review.
    const sortOptions = { sortBy, order, pinFeatured: false as const };

    // Push filtering, sorting, and pagination to the DB so we never fetch
    // the entire characters table into memory. Run count and page in parallel.
    const [totalCount, paginatedCharacters] = await Promise.all([
      userCharactersRepository.count(filters, user.id, user.organization_id),
      userCharactersRepository.search(
        filters,
        user.id,
        user.organization_id,
        sortOptions,
        limit,
        offset,
      ),
    ]);

    const totalPages = Math.ceil(totalCount / limit);

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
    const decodedRawBody = await decodeRequestJson(c.req);
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = decodedRawBody.value;
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const elizaCharacter = rawBody as ElizaCharacter;
    // Only array-valued document sources participate in character knowledge.
    const documentSources = [
      ...(Array.isArray(elizaCharacter.documents)
        ? elizaCharacter.documents
        : []),
      ...(Array.isArray(elizaCharacter.knowledge)
        ? elizaCharacter.knowledge
        : []),
    ];

    // Normalize isPublic to ensure consistency between is_public column and character_data
    const isPublic =
      typeof elizaCharacter.isPublic === "boolean"
        ? elizaCharacter.isPublic
        : false;

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
      message_examples: (elizaCharacter.messageExamples ?? []) as Record<
        string,
        unknown
      >[][],
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

    const character = await charactersService.create(newCharacter, {
      policy: { mode: "metered" },
    });

    discordService
      .logCharacterCreated({
        characterId: character.id,
        characterName: character.name,
        userName: user.email || null,
        userId: user.id,
        organizationName: user.organization.name ?? "",
        bio: Array.isArray(elizaCharacter.bio)
          ? elizaCharacter.bio.join(" ")
          : elizaCharacter.bio,
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
