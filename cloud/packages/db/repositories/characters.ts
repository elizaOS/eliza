import { and, desc, eq, inArray, or, SQL, sql } from "drizzle-orm";
import type { SearchFilters, SortOptions } from "@/lib/types/my-agents";
import { normalizeTokenAddress } from "@/lib/utils/token-address";
import { dbRead, dbWrite } from "../helpers";
import { elizaRoomCharactersTable } from "../schemas/eliza-room-characters";
import {
  type NewUserCharacter,
  type UserCharacter,
  userCharacters,
} from "../schemas/user-characters";

export type { NewUserCharacter, UserCharacter };

/**
 * Escapes special LIKE pattern characters to prevent pattern injection.
 * Characters %, _, and \ have special meaning in SQL LIKE patterns.
 */
function escapeLikePattern(str: string): string {
  return str.replace(/[%_\\]/g, "\\$&");
}

function ilikeEscaped(column: unknown, query: string): SQL {
  return sql`${column as SQL} ILIKE ${`%${escapeLikePattern(query)}%`} ESCAPE '\\'`;
}

/**
 * Repository for user character database operations.
 */
export class UserCharactersRepository {
  /**
   * Builds search conditions for user character queries.
   * Used by both search and count methods to avoid duplication.
   */
  private buildSearchConditions(filters: SearchFilters, userId: string): SQL[] {
    const conditions: SQL[] = [];

    if (filters.search) {
      conditions.push(
        or(
          ilikeEscaped(userCharacters.name, filters.search),
          ilikeEscaped(sql`${userCharacters.bio}::text`, filters.search),
        )!,
      );
    }

    if (filters.category) {
      conditions.push(eq(userCharacters.category, filters.category));
    }

    if (filters.hasVoice) {
      conditions.push(
        sql`${userCharacters.plugins}::jsonb @> '["@elizaos/plugin-elevenlabs"]'::jsonb`,
      );
    }

    if (filters.template !== undefined) {
      conditions.push(eq(userCharacters.is_template, filters.template));
    }

    if (filters.public !== undefined) {
      conditions.push(eq(userCharacters.is_public, filters.public));
    }

    if (filters.featured !== undefined) {
      conditions.push(eq(userCharacters.featured, filters.featured));
    }

    // Filter by source (cloud vs miniapp)
    if (filters.source) {
      conditions.push(eq(userCharacters.source, filters.source));
    }

    // Include characters that user owns OR has interacted with via chat rooms
    // This allows affiliate-created characters (clone-your-crush) to appear in my-agents
    // when the user has chatted with them, even if they don't "own" the character
    const interactedCharacterIds = dbRead
      .selectDistinct({ character_id: elizaRoomCharactersTable.character_id })
      .from(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.user_id, userId));

    conditions.push(
      or(eq(userCharacters.user_id, userId), inArray(userCharacters.id, interactedCharacterIds))!,
    );

    return conditions;
  }

  /**
   * Builds search conditions for public character queries.
   * Used by both searchPublic and countPublic methods to avoid duplication.
   */
  private buildPublicSearchConditions(
    filters: Omit<SearchFilters, "myCharacters" | "deployed">,
  ): SQL[] {
    const conditions: SQL[] = [];

    conditions.push(or(eq(userCharacters.is_template, true), eq(userCharacters.is_public, true))!);

    if (filters.search) {
      conditions.push(
        or(
          ilikeEscaped(userCharacters.name, filters.search),
          ilikeEscaped(sql`${userCharacters.bio}::text`, filters.search),
        )!,
      );
    }

    if (filters.category) {
      conditions.push(eq(userCharacters.category, filters.category));
    }

    if (filters.hasVoice) {
      conditions.push(
        sql`${userCharacters.plugins}::jsonb @> '["@elizaos/plugin-elevenlabs"]'::jsonb`,
      );
    }

    if (filters.template !== undefined) {
      conditions.push(eq(userCharacters.is_template, filters.template));
    }

    if (filters.featured !== undefined) {
      conditions.push(eq(userCharacters.featured, filters.featured));
    }

    // Filter by source (cloud vs miniapp) - miniapp agents should never appear in public marketplace
    if (filters.source) {
      conditions.push(eq(userCharacters.source, filters.source));
    }

    return conditions;
  }

  /**
   * Finds a character by ID.
   */
  async findById(id: string): Promise<UserCharacter | undefined> {
    return await dbRead.query.userCharacters.findFirst({
      where: eq(userCharacters.id, id),
    });
  }

  /**
   * Finds a character by ID within an organization.
   */
  async findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<UserCharacter | undefined> {
    return await dbRead.query.userCharacters.findFirst({
      where: and(eq(userCharacters.id, id), eq(userCharacters.organization_id, organizationId)),
    });
  }

  /**
   * Finds a character by ID within an organization using the primary DB.
   * Use this for write-after-write validation paths that require fresh data.
   */
  async findByIdInOrganizationForWrite(
    id: string,
    organizationId: string,
  ): Promise<UserCharacter | undefined> {
    return await dbWrite.query.userCharacters.findFirst({
      where: and(eq(userCharacters.id, id), eq(userCharacters.organization_id, organizationId)),
    });
  }

  /**
   * Finds characters by ID in a single query.
   */
  async findByIds(ids: string[]): Promise<UserCharacter[]> {
    if (ids.length === 0) {
      return [];
    }

    return await dbRead.select().from(userCharacters).where(inArray(userCharacters.id, ids));
  }

  /**
   * Finds characters by ID within an organization.
   */
  async findByIdsInOrganization(ids: string[], organizationId: string): Promise<UserCharacter[]> {
    if (ids.length === 0) {
      return [];
    }

    return await dbRead
      .select()
      .from(userCharacters)
      .where(
        and(inArray(userCharacters.id, ids), eq(userCharacters.organization_id, organizationId)),
      );
  }

  /**
   * Finds a character by token address (and optionally chain).
   * Returns the canonical agent linked to a specific on-chain token.
   *
   * The incoming address is normalised (EVM → lowercase, Solana → untouched)
   * before comparison.  Write paths apply the same normalisation, so an exact
   * match is sufficient for new data.
   *
   * For backward-compatibility with pre-normalisation rows we also fall back to
   * `lower(token_address) = $normalised` — but only when the normalised value
   * is already all-lowercase (i.e. EVM).  This avoids false positives on
   * case-sensitive chains like Solana where lowering would conflate distinct
   * base58 addresses.
   */
  async findByTokenAddress(
    tokenAddress: string,
    tokenChain?: string,
  ): Promise<UserCharacter | undefined> {
    const normalized = normalizeTokenAddress(tokenAddress, tokenChain);
    const isLowered = normalized === normalized.toLowerCase();

    // Primary: exact match (works for all chains after normalisation on write).
    // Fallback (EVM only): lower(stored) = normalised catches mixed-case rows.
    const addressCondition = isLowered
      ? sql`(${userCharacters.token_address} = ${normalized} OR lower(${userCharacters.token_address}) = ${normalized})`
      : eq(userCharacters.token_address, normalized);

    const conditions: SQL[] = [addressCondition];
    if (tokenChain) {
      conditions.push(eq(userCharacters.token_chain, tokenChain));
    }
    const rows = await dbRead
      .select()
      .from(userCharacters)
      .where(and(...conditions))
      .limit(1);
    return rows[0];
  }

  /**
   * Lists all characters that have a token linkage.
   * Useful for dashboards that show token-linked agents.
   */
  async listTokenLinked(options?: {
    chain?: string;
    organizationId?: string;
    limit?: number;
  }): Promise<UserCharacter[]> {
    const conditions: SQL[] = [sql`${userCharacters.token_address} IS NOT NULL`];
    if (options?.chain) {
      conditions.push(eq(userCharacters.token_chain, options.chain));
    }
    if (options?.organizationId) {
      conditions.push(eq(userCharacters.organization_id, options.organizationId));
    }
    return await dbRead
      .select()
      .from(userCharacters)
      .where(and(...conditions))
      .orderBy(desc(userCharacters.created_at))
      .limit(options?.limit ?? 100);
  }

  /**
   * Finds a character by username.
   */
  async findByUsername(username: string): Promise<UserCharacter | undefined> {
    return await dbRead.query.userCharacters.findFirst({
      where: eq(userCharacters.username, username.toLowerCase()),
    });
  }

  /**
   * Checks if a username exists.
   */
  async usernameExists(username: string): Promise<boolean> {
    const result = await dbRead
      .select({ id: userCharacters.id })
      .from(userCharacters)
      .where(eq(userCharacters.username, username.toLowerCase()))
      .limit(1);
    return result.length > 0;
  }

  /**
   * Gets all existing usernames (for bulk uniqueness check).
   */
  async getAllUsernames(): Promise<Set<string>> {
    const result = await dbRead.select({ username: userCharacters.username }).from(userCharacters);

    const usernames = new Set<string>();
    for (const row of result) {
      if (row.username) {
        usernames.add(row.username.toLowerCase());
      }
    }
    return usernames;
  }

  /**
   * Lists characters for a user, including owned and interacted characters.
   *
   * Includes characters the user owns or has interacted with via chat rooms,
   * allowing affiliate-created characters to appear in the selector.
   *
   * @param userId - User ID to list characters for.
   * @param source - Filter by source type (default: "cloud").
   */
  async listByUser(
    userId: string,
    source: "cloud" | "miniapp" = "cloud",
  ): Promise<UserCharacter[]> {
    const interactedCharacterIds = dbRead
      .selectDistinct({ character_id: elizaRoomCharactersTable.character_id })
      .from(elizaRoomCharactersTable)
      .where(eq(elizaRoomCharactersTable.user_id, userId));

    return await dbRead
      .selectDistinct()
      .from(userCharacters)
      .where(
        and(
          eq(userCharacters.source, source),
          or(
            eq(userCharacters.user_id, userId),
            inArray(userCharacters.id, interactedCharacterIds),
          ),
        ),
      )
      .orderBy(desc(userCharacters.created_at));
  }

  /**
   * Lists characters for an organization.
   *
   * @param organizationId - Organization ID.
   * @param source - Filter by source type (default: "cloud").
   */
  async listByOrganization(
    organizationId: string,
    source: "cloud" | "miniapp" = "cloud",
  ): Promise<UserCharacter[]> {
    return await dbRead.query.userCharacters.findMany({
      where: and(
        eq(userCharacters.organization_id, organizationId),
        eq(userCharacters.source, source),
      ),
      orderBy: desc(userCharacters.created_at),
    });
  }

  /**
   * Lists public characters (cloud source only). Always bounded — pass a
   * limit/offset for pagination instead of relying on caller-side slicing.
   * `name` search is pushed into SQL when provided; `bio` is jsonb and is
   * filtered client-side by callers if needed.
   */
  async listPublic(
    options: { search?: string; category?: string; limit?: number; offset?: number } = {},
  ): Promise<UserCharacter[]> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions: SQL[] = [
      eq(userCharacters.is_public, true),
      eq(userCharacters.source, "cloud"),
    ];

    if (options.category) {
      conditions.push(eq(userCharacters.category, options.category));
    }

    if (options.search) {
      conditions.push(ilikeEscaped(userCharacters.name, options.search));
    }

    return await dbRead.query.userCharacters.findMany({
      where: and(...conditions),
      orderBy: desc(userCharacters.created_at),
      limit,
      offset,
    });
  }

  /**
   * Lists all template characters (cloud source only).
   */
  async listTemplates(): Promise<UserCharacter[]> {
    return await dbRead.query.userCharacters.findMany({
      where: and(eq(userCharacters.is_template, true), eq(userCharacters.source, "cloud")),
      orderBy: desc(userCharacters.created_at),
    });
  }

  /**
   * Creates a new character.
   */
  async create(data: NewUserCharacter): Promise<UserCharacter> {
    const [character] = await dbWrite.insert(userCharacters).values(data).returning();
    return character;
  }

  /**
   * Updates an existing character.
   */
  async update(id: string, data: Partial<NewUserCharacter>): Promise<UserCharacter | undefined> {
    const [updated] = await dbWrite
      .update(userCharacters)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(userCharacters.id, id))
      .returning();
    return updated;
  }

  /**
   * Deletes a character by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(userCharacters).where(eq(userCharacters.id, id));
  }

  /**
   * Builds the sort order expression for search queries.
   */
  private buildSortOrder(sortOptions: SortOptions) {
    const { sortBy, order } = sortOptions;
    const direction = order === "asc" ? "asc" : "desc";

    switch (sortBy) {
      case "popularity":
        return direction === "asc"
          ? userCharacters.popularity_score
          : desc(userCharacters.popularity_score);
      case "newest":
        return direction === "asc" ? userCharacters.created_at : desc(userCharacters.created_at);
      case "name":
        return direction === "asc" ? userCharacters.name : desc(userCharacters.name);
      case "updated":
        return direction === "asc" ? userCharacters.updated_at : desc(userCharacters.updated_at);
      default:
        return desc(userCharacters.popularity_score);
    }
  }

  /**
   * Searches characters with filters and sorting.
   *
   * Includes characters the user owns or has interacted with via chat rooms.
   */
  async search(
    filters: SearchFilters,
    userId: string,
    _organizationId: string,
    sortOptions: SortOptions,
    limit: number,
    offset: number,
  ): Promise<UserCharacter[]> {
    const conditions = this.buildSearchConditions(filters, userId);
    const secondaryOrderBy = this.buildSortOrder(sortOptions);

    return await dbRead
      .select()
      .from(userCharacters)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(userCharacters.featured), secondaryOrderBy)
      .limit(limit)
      .offset(offset);
  }

  /**
   * Counts characters matching the search filters.
   */
  async count(filters: SearchFilters, userId: string, _organizationId: string): Promise<number> {
    const conditions = this.buildSearchConditions(filters, userId);

    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(userCharacters)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return result[0]?.count || 0;
  }

  /**
   * Atomically increments the view count for a character.
   */
  async incrementViewCount(id: string): Promise<void> {
    await dbWrite
      .update(userCharacters)
      .set({
        view_count: sql`${userCharacters.view_count} + 1`,
      })
      .where(eq(userCharacters.id, id));
  }

  /**
   * Atomically increments the interaction count for a character.
   */
  async incrementInteractionCount(id: string): Promise<void> {
    await dbWrite
      .update(userCharacters)
      .set({
        interaction_count: sql`${userCharacters.interaction_count} + 1`,
      })
      .where(eq(userCharacters.id, id));
  }

  /**
   * Updates the popularity score for a character.
   */
  async updatePopularityScore(id: string, score: number): Promise<void> {
    await dbWrite
      .update(userCharacters)
      .set({
        popularity_score: score,
      })
      .where(eq(userCharacters.id, id));
  }

  /**
   * Gets featured characters (cloud source only).
   *
   * @param limit - Maximum number of characters to return (default: 10).
   */
  async getFeatured(limit: number = 10): Promise<UserCharacter[]> {
    return await dbRead.query.userCharacters.findMany({
      where: and(eq(userCharacters.featured, true), eq(userCharacters.source, "cloud")),
      orderBy: desc(userCharacters.popularity_score),
      limit,
    });
  }

  /**
   * Gets popular characters (cloud source only).
   *
   * @param limit - Maximum number of characters to return (default: 20).
   */
  async getPopular(limit: number = 20): Promise<UserCharacter[]> {
    return await dbRead.query.userCharacters.findMany({
      where: and(
        or(eq(userCharacters.is_template, true), eq(userCharacters.is_public, true)),
        eq(userCharacters.source, "cloud"),
      ),
      orderBy: desc(userCharacters.popularity_score),
      limit,
    });
  }

  /**
   * Searches public characters (templates and public characters).
   */
  async searchPublic(
    filters: Omit<SearchFilters, "myCharacters" | "deployed">,
    sortOptions: SortOptions,
    limit: number,
    offset: number,
  ): Promise<UserCharacter[]> {
    const conditions = this.buildPublicSearchConditions(filters);
    const secondaryOrderBy = this.buildSortOrder(sortOptions);

    return await dbRead
      .select()
      .from(userCharacters)
      .where(and(...conditions))
      .orderBy(desc(userCharacters.featured), secondaryOrderBy)
      .limit(limit)
      .offset(offset);
  }

  /**
   * Counts public characters matching the filters.
   */
  async countPublic(filters: Omit<SearchFilters, "myCharacters" | "deployed">): Promise<number> {
    const conditions = this.buildPublicSearchConditions(filters);

    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(userCharacters)
      .where(and(...conditions));

    return result[0]?.count || 0;
  }
}

/**
 * Singleton instance of UserCharactersRepository.
 */
export const userCharactersRepository = new UserCharactersRepository();
