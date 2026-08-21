/**
 * Service for managing user characters (CRUD operations).
 *
 * PERFORMANCE: Character data is cached in Redis for fast runtime access.
 */

import { type Agent, ElizaError } from "@elizaos/core";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { type DbTransaction, dbRead, dbWrite } from "../../../db/client";
import {
  type NewUserCharacter,
  type UserCharacter,
  userCharactersRepository,
} from "../../../db/repositories";

export type { UserCharacter } from "../../../db/repositories";

import { agentsRepository } from "../../../db/repositories/agents/agents";
import {
  elizaRoomCharactersTable,
  organizations,
  userCharacters,
  users,
} from "../../../db/schemas";
import { memoryTable, participantTable, roomTable } from "../../../db/schemas/eliza";
import { ValidationError } from "../../api/cloud-worker-errors";
import { cache } from "../../cache/client";
import { InMemoryLRUCache } from "../../cache/in-memory-lru-cache";
import { CacheKeys, CacheTTL } from "../../cache/keys";
import {
  type CloudCharacterLimitSource,
  resolveMaxCloudCharactersForOrg,
} from "../../constants/cloud-character-quota";
import type { ElizaCharacter } from "../../types/eliza-character";
import {
  generateUniqueUsername,
  generateUsernameFromName,
  RESERVED_USERNAMES,
  validateUsername,
} from "../../utils/agent-username";
import { logger } from "../../utils/logger";
import { usersService } from "../users";

// Cache key for character data (longer TTL since characters rarely change)
const characterCacheKey = (id: string) => `character:data:${id}`;
const CHARACTER_CACHE_TTL = CacheTTL.agent.characterData; // 1 hour
const USERNAME_AUTHORITY_LOCK_TIMEOUT_MS = 10_000;
const USERNAME_AUTHORITY_STATEMENT_TIMEOUT_MS = 30_000;
const USERNAME_AUTHORITY_LOCK_NAMESPACE = "cloud-character";
const USERNAME_AUTHORITY_LOCK_KEY = "username-claim";

/**
 * PERF: In-memory cache for character data (60s TTL).
 * Characters rarely change during active sessions. This eliminates the Redis
 * round-trip (~5ms) for repeated lookups within the same serverless instance.
 */
const inMemoryCharCache = new InMemoryLRUCache<UserCharacter>(100, 60_000);
const characterHydrations = new Map<string, Promise<void>>();

export type InferenceCharacterCacheResolution =
  | { kind: "ready"; character: UserCharacter | null }
  | { kind: "warming" | "unavailable" };

export type CharacterCreationPolicy =
  | { mode: "metered" }
  | { mode: "bootstrap" }
  | {
      mode: "trusted";
      caller: "affiliate-create-character" | "service-api-v1-agents";
    };

export interface CharacterCreationOptions {
  policy: CharacterCreationPolicy;
}

export interface CharacterCreationQuotaReceipt {
  currentBefore: number;
  currentAfter: number;
  limit: number;
  limitSource: CloudCharacterLimitSource;
}

export interface CharacterCreationReceipt {
  character: UserCharacter;
  created: boolean;
  quota?: CharacterCreationQuotaReceipt;
}

export interface MeteredCharacterCreationReceipt extends CharacterCreationReceipt {
  created: true;
  quota: CharacterCreationQuotaReceipt;
}

const TRUSTED_CHARACTER_CREATION_CALLERS = new Set([
  "affiliate-create-character",
  "service-api-v1-agents",
]);

function requireCharacterCreationPolicy(
  options: CharacterCreationOptions | undefined,
): CharacterCreationPolicy {
  const candidate: unknown = options?.policy;
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
    const record = candidate as Record<string, unknown>;
    if (record.mode === "metered" || record.mode === "bootstrap") {
      return { mode: record.mode };
    }
    if (
      record.mode === "trusted" &&
      typeof record.caller === "string" &&
      TRUSTED_CHARACTER_CREATION_CALLERS.has(record.caller)
    ) {
      return {
        mode: "trusted",
        caller: record.caller as "affiliate-create-character" | "service-api-v1-agents",
      };
    }
  }

  throw new ElizaError("Character creation requires a valid explicit quota policy", {
    code: "CHARACTER_CREATION_POLICY_REQUIRED",
    severity: "fatal",
  });
}

/** Raised when a metered character create observes no remaining org capacity. */
export class CloudCharacterQuotaExceededError extends ElizaError {
  override readonly name = "CloudCharacterQuotaExceededError";
  readonly organizationId: string;
  readonly current: number;
  readonly limit: number;
  readonly limitSource: CloudCharacterLimitSource;

  constructor(params: {
    organizationId: string;
    current: number;
    limit: number;
    limitSource: CloudCharacterLimitSource;
  }) {
    super(
      `Agent quota exceeded. Your organization has reached the maximum of ${params.limit} agents.`,
      {
        code: "CLOUD_CHARACTER_QUOTA_EXCEEDED",
        context: params,
        severity: "ephemeral",
      },
    );
    this.organizationId = params.organizationId;
    this.current = params.current;
    this.limit = params.limit;
    this.limitSource = params.limitSource;
  }
}

function mirroredAgent(character: UserCharacter): Partial<Agent> {
  return {
    id: character.id as `${string}-${string}-${string}-${string}-${string}`,
    name: character.name,
    username: character.username ?? undefined,
    bio: character.bio as string[] | undefined,
    system: character.system ?? undefined,
    enabled: true,
    settings: character.settings as Record<
      string,
      string | number | boolean | Record<string, string | number | boolean>
    >,
  };
}

/** Ensures a lock waiter scans from a fresh snapshot after its predecessor commits. */
async function withCharacterCreationTransaction<T>(
  operation: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return await dbWrite.transaction(operation, { isolationLevel: "read committed" });
}

/**
 * Serializes every username claim across organizations.
 *
 * The username index is global, while the create authority's row lock is
 * intentionally per organization. This transaction-scoped advisory lock must
 * therefore be held before either an explicit existence check or an automatic
 * global scan chooses a candidate, and through the insert that claims it. The
 * caller pins READ COMMITTED so a waiter scans from a fresh snapshot after the
 * preceding lock holder commits.
 */
async function lockUsernameClaimAuthority(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`
    SELECT
      set_config('lock_timeout', ${`${USERNAME_AUTHORITY_LOCK_TIMEOUT_MS}ms`}, TRUE),
      set_config('statement_timeout', ${`${USERNAME_AUTHORITY_STATEMENT_TIMEOUT_MS}ms`}, TRUE)
  `);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${USERNAME_AUTHORITY_LOCK_NAMESPACE}), hashtext(${USERNAME_AUTHORITY_LOCK_KEY}))`,
  );
}

/**
 * Service for character CRUD operations.
 */
export class CharactersService {
  /**
   * Get character by ID with caching.
   * PERFORMANCE: 3-layer cache: in-memory (~0ms) > Redis (~5ms) > DB (~50ms)
   */
  async getById(id: string): Promise<UserCharacter | undefined> {
    // PERF: Check in-memory cache first (eliminates Redis round-trip)
    const inMemoryHit = inMemoryCharCache.get(id);
    if (inMemoryHit) {
      logger.debug(`[Characters] ⚡ In-memory cache HIT: ${id}`);
      return structuredClone(inMemoryHit);
    }

    const cacheKey = characterCacheKey(id);

    // Try Redis cache
    const cached = await cache.get<UserCharacter>(cacheKey);
    if (cached) {
      logger.debug(`[Characters] ⚡ Redis cache HIT: ${id}`);
      inMemoryCharCache.set(id, cached);
      return structuredClone(cached);
    }

    // Fetch from database
    const character = await userCharactersRepository.findById(id);

    // Cache for future requests (Redis: 1 hour, in-memory: 60s)
    if (character) {
      await cache.set(cacheKey, character, CHARACTER_CACHE_TTL);
      inMemoryCharCache.set(id, character);
      logger.debug(`[Characters] Cache MISS, cached: ${id}`);
      return structuredClone(character);
    }

    return character;
  }

  /**
   * Resolve a character for a Worker inference request without falling through
   * to Postgres. Cold entries hydrate under `waitUntil`; repeated turns in the
   * same isolate normally resolve from the in-process LRU without remote I/O.
   */
  async getByIdCacheOnly(
    id: string,
    options: { executionCtx?: { waitUntil(promise: Promise<unknown>): void } } = {},
  ): Promise<InferenceCharacterCacheResolution> {
    const inMemoryHit = inMemoryCharCache.get(id);
    if (inMemoryHit) {
      return { kind: "ready", character: structuredClone(inMemoryHit) };
    }

    const outcome = await cache.getWithOutcome<UserCharacter>(characterCacheKey(id));
    if (outcome.kind === "hit") {
      inMemoryCharCache.set(id, outcome.value);
      return { kind: "ready", character: structuredClone(outcome.value) };
    }

    if (options.executionCtx) {
      let hydration = characterHydrations.get(id);
      if (!hydration) {
        hydration = this.getById(id)
          .then(() => undefined)
          .catch((error) => {
            // error-policy:J7 a cold inference retry remains fail-closed while
            // the authoritative character hydration failure is observable.
            logger.warn("[Characters] Background inference hydration failed", {
              characterId: id,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            characterHydrations.delete(id);
          });
        characterHydrations.set(id, hydration);
      }
      options.executionCtx.waitUntil(hydration);
    }

    return {
      kind: outcome.kind === "unavailable" || outcome.kind === "error" ? "unavailable" : "warming",
    };
  }

  /**
   * Invalidate character cache (call after updates)
   * CRITICAL: This now also invalidates the in-memory runtime cache
   */
  async invalidateCache(id: string): Promise<void> {
    inMemoryCharCache.delete(id);
    // Import dynamically to avoid circular dependency
    const { invalidateCharacterCache } = await import("../../cache/character-cache");

    await Promise.all([
      // Invalidate the simple character cache key
      cache.del(characterCacheKey(id)),
      // CRITICAL: Invalidate ALL character-related caches including runtime
      // This ensures MCP, knowledge, web search changes take effect immediately
      invalidateCharacterCache(id),
    ]);

    logger.info(`[Characters] Cache invalidated for character: ${id}`);
  }

  async getByIdForUser(characterId: string, userId: string): Promise<UserCharacter | null> {
    const character = await userCharactersRepository.findById(characterId);

    if (!character || character.user_id !== userId) {
      return null;
    }

    return character;
  }

  async listByUser(
    userId: string,
    options?: {
      limit?: number;
      includeTemplates?: boolean;
      source?: "cloud";
    },
  ): Promise<UserCharacter[]> {
    const source = options?.source ?? "cloud";

    // If templates are requested, get them separately
    if (options?.includeTemplates) {
      const [userChars, templates] = await Promise.all([
        userCharactersRepository.listByUser(userId, source),
        userCharactersRepository.listTemplates(),
      ]);
      return [...userChars, ...templates];
    }

    return await userCharactersRepository.listByUser(userId, source);
  }

  async listByOrganization(
    organizationId: string,
    options?: { source?: "cloud" },
  ): Promise<UserCharacter[]> {
    const source = options?.source ?? "cloud";
    return await userCharactersRepository.listByOrganization(organizationId, source);
  }

  /**
   * Bounded existence probe: does the organization have any cloud character?
   * For callers that only need emptiness, where listByOrganization would
   * fetch every fat character row. Default-character self-heal uses the
   * stronger mirror-health probe below.
   */
  async existsForOrganization(organizationId: string): Promise<boolean> {
    return await userCharactersRepository.existsForOrganization(organizationId, "cloud");
  }

  /**
   * Read-only fast path for default-character self-heal. A false result is not
   * authority to create; Steward routes it to create(..., bootstrap), where
   * the primary organization lock makes the final ensure decision.
   */
  async hasHealthyCloudCharacterMirror(organizationId: string): Promise<boolean> {
    return await userCharactersRepository.hasHealthyCloudCharacterMirror(organizationId);
  }

  async listPublic(options?: {
    search?: string;
    category?: string;
    limit?: number;
    offset?: number;
    orderBy?: "name";
  }): Promise<UserCharacter[]> {
    return await userCharactersRepository.listPublic(options);
  }

  async countPublicCatalog(options?: { search?: string; category?: string }): Promise<number> {
    return await userCharactersRepository.countPublicCatalog(options);
  }

  async listTemplates(): Promise<UserCharacter[]> {
    return await userCharactersRepository.listTemplates();
  }

  /**
   * Generate a unique username for a character.
   * Uses the name to create a slug, then ensures uniqueness.
   */
  async generateUniqueUsername(name: string, tx?: DbTransaction): Promise<string> {
    // Get all existing usernames
    const existingUsernames = await userCharactersRepository.getAllUsernames(tx);

    // Add reserved usernames
    for (const reserved of RESERVED_USERNAMES) {
      existingUsernames.add(reserved);
    }

    // Generate base username from name
    const baseUsername = generateUsernameFromName(name);

    // Make it unique
    return generateUniqueUsername(baseUsername, existingUsernames);
  }

  /**
   * Validate a username for update.
   * Checks format and uniqueness (excluding the character's own username).
   */
  async validateUsernameForUpdate(
    username: string,
    characterId: string,
  ): Promise<{ valid: boolean; error?: string }> {
    // Validate format
    const validation = validateUsername(username);
    if (!validation.valid) {
      return { valid: false, error: validation.error };
    }

    // Check uniqueness (excluding own character)
    const existing = await userCharactersRepository.findByUsername(username);
    if (existing && existing.id !== characterId) {
      return { valid: false, error: "This username is already taken" };
    }

    return { valid: true };
  }

  /**
   * Get a character by username.
   */
  async getByUsername(username: string): Promise<UserCharacter | undefined> {
    return await userCharactersRepository.findByUsername(username);
  }

  async create(data: NewUserCharacter, options: CharacterCreationOptions): Promise<UserCharacter> {
    return (await this.createWithReceipt(data, options)).character;
  }

  /**
   * Creates a character and returns the decision made inside the authoritative
   * transaction. Metered HTTP callers use the receipt to preserve authoritative
   * quota observability without issuing a stale post-commit replica read.
   */
  async createWithReceipt(
    data: NewUserCharacter,
    options: { policy: { mode: "metered" } },
  ): Promise<MeteredCharacterCreationReceipt>;
  async createWithReceipt(
    data: NewUserCharacter,
    options: CharacterCreationOptions,
  ): Promise<CharacterCreationReceipt>;
  async createWithReceipt(
    data: NewUserCharacter,
    options: CharacterCreationOptions,
  ): Promise<CharacterCreationReceipt> {
    // `name` arrives from the same pre-validation request body as `username`
    // (the route casts raw JSON to ElizaCharacter). A non-string name 500s via
    // slugify(name).toLowerCase() in generateUniqueUsername below; and when a
    // username IS supplied so slugify is skipped, a non-string name persists
    // and then 500s the public discovery/list reads (char.name.toLowerCase(),
    // localeCompare) for every viewer (#13637 / #13713 class). Reject up front.
    if (typeof data.name !== "string" || data.name.trim().length === 0) {
      throw ValidationError("Invalid name: must be a non-empty string");
    }

    const policy = requireCharacterCreationPolicy(options);

    const source = data.source ?? "cloud";
    if (source !== "cloud") {
      throw ValidationError("CharactersService.create only accepts Cloud characters");
    }

    // Format validation is request-local. Global uniqueness is resolved later
    // on the same primary transaction as the quota and inserts.
    let username = data.username;
    if (username !== undefined && username !== null && username !== "") {
      if (typeof username !== "string") {
        // Character creation receives request bodies before route-level shape
        // validation, so username can be any JSON value. Rejecting here keeps
        // create/update behavior aligned and prevents validateUsername from
        // turning malformed input into a TypeError 500 (#13637 class).
        throw ValidationError("Invalid username: must be a string");
      }
      const validation = validateUsername(username);
      if (!validation.valid) {
        // A genuinely-invalid provided username is caller error, not a server
        // fault (#13637 class) — matches the non-string branch above.
        throw ValidationError(`Invalid username: ${validation.error}`);
      }

      username = validation.normalized!;
    }

    const result = await withCharacterCreationTransaction<CharacterCreationReceipt>(async (tx) => {
      // The organization row is the per-tenant serialization authority. The
      // billing inputs, exact Cloud population, decision, character insert,
      // and required runtime mirror therefore share one primary transaction.
      const [organization] = await tx
        .select({
          id: organizations.id,
          creditBalance: organizations.credit_balance,
          settings: organizations.settings,
        })
        .from(organizations)
        .where(eq(organizations.id, data.organization_id))
        .limit(1)
        .for("update");

      if (!organization) {
        throw new ElizaError("Character organization not found", {
          code: "CHARACTER_ORGANIZATION_NOT_FOUND",
          context: { organizationId: data.organization_id },
          severity: "fatal",
        });
      }

      const [population] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(userCharacters)
        .where(
          and(
            eq(userCharacters.organization_id, data.organization_id),
            eq(userCharacters.source, "cloud"),
          ),
        );
      const current = Number(population?.count ?? 0);

      if (policy.mode === "bootstrap" && current > 0) {
        const [existing] = await tx
          .select()
          .from(userCharacters)
          .where(
            and(
              eq(userCharacters.organization_id, data.organization_id),
              eq(userCharacters.source, "cloud"),
            ),
          )
          .orderBy(userCharacters.created_at, userCharacters.id)
          .limit(1);
        if (!existing) {
          throw new ElizaError("Cloud character count and rows disagree", {
            code: "CLOUD_CHARACTER_POPULATION_INCONSISTENT",
            context: { organizationId: data.organization_id, current },
            severity: "fatal",
          });
        }

        // Bootstrap doubles as repair for a pre-existing character whose
        // legacy two-step create crashed before its runtime mirror was written.
        await agentsRepository.ensure(mirroredAgent(existing), tx);
        return { character: existing, created: false };
      }

      let quota: CharacterCreationQuotaReceipt | undefined;
      if (policy.mode === "metered") {
        const resolution = resolveMaxCloudCharactersForOrg(
          Number(organization.creditBalance),
          organization.settings,
        );
        if (current >= resolution.limit) {
          throw new CloudCharacterQuotaExceededError({
            organizationId: data.organization_id,
            current,
            limit: resolution.limit,
            limitSource: resolution.source,
          });
        }
        quota = {
          currentBefore: current,
          currentAfter: current + 1,
          limit: resolution.limit,
          limitSource: resolution.source,
        };
      }

      // All insertion paths take the same global namespace authority after
      // their organization lock. This uniform order cannot cycle, and makes
      // the explicit check and automatic scan authoritative against each
      // other until the unique claim commits.
      await lockUsernameClaimAuthority(tx);

      if (username === undefined || username === null || username === "") {
        // Blank is provided-but-unset (empty-is-unset contract), same as
        // omitting the field. Bootstrap checks existing rows before reaching
        // this point so concurrent ensure calls never fail on their shared
        // deterministic username.
        username = await this.generateUniqueUsername(data.name, tx);
        logger.info(`[Characters] Generated username: @${username} for "${data.name}"`);
      } else if (await userCharactersRepository.usernameExists(username, tx)) {
        throw ValidationError("Username is already taken");
      }

      const character = await userCharactersRepository.create(
        {
          ...data,
          source: "cloud",
          username,
        },
        tx,
      );
      const mirrorCreated = await agentsRepository.create(mirroredAgent(character), tx);
      if (!mirrorCreated) {
        throw new ElizaError("Character runtime mirror already exists", {
          code: "CHARACTER_AGENT_MIRROR_CONFLICT",
          context: {
            organizationId: data.organization_id,
            characterId: character.id,
          },
          severity: "fatal",
        });
      }

      return {
        character,
        created: true,
        ...(quota ? { quota } : {}),
      };
    });

    if (policy.mode === "trusted") {
      logger.info("[Characters] Trusted character quota policy used", {
        caller: policy.caller,
        organizationId: data.organization_id,
        characterId: result.character.id,
      });
    }
    if (result.created) {
      await cache.del(CacheKeys.org.dashboard(data.organization_id));
    }

    return result;
  }

  async update(id: string, data: Partial<NewUserCharacter>): Promise<UserCharacter | undefined> {
    const updated = await userCharactersRepository.update(id, data);
    // Invalidate cache on update
    if (updated) {
      await this.invalidateCache(id);
    }
    return updated;
  }

  async updateForUser(
    characterId: string,
    userId: string,
    updates: Partial<NewUserCharacter>,
  ): Promise<UserCharacter | null> {
    // Verify ownership
    const character = await this.getByIdForUser(characterId, userId);
    if (!character) {
      return null;
    }

    // If username is being updated, validate it
    // Normalize before comparison to prevent validation bypass with different casing
    // Handle null explicitly (allows clearing the username)
    if (updates.username !== undefined) {
      if (updates.username === null) {
        // Allow clearing username - no validation needed
        logger.info(`[Characters] Username cleared: @${character.username} → null`);
      } else if (typeof updates.username !== "string") {
        // The PUT route passes the request body through unvalidated, so
        // username can be any JSON shape; a non-string can't be normalized or
        // validated and must reject as a 400, not a TypeError 500 (#13637
        // class).
        throw ValidationError("Invalid username: must be a string");
      } else {
        const normalizedUsername = updates.username.toLowerCase();
        if (normalizedUsername !== character.username) {
          const validation = await this.validateUsernameForUpdate(normalizedUsername, characterId);
          if (!validation.valid) {
            throw new Error(`Invalid username: ${validation.error}`);
          }
          updates.username = normalizedUsername;
          logger.info(
            `[Characters] Username updated: @${character.username} → @${updates.username}`,
          );
        } else {
          // Same username after normalization, ensure it's stored normalized
          updates.username = normalizedUsername;
        }
      }
    }

    const updated = await userCharactersRepository.update(characterId, updates);

    // CRITICAL: Invalidate cache after update (including runtime cache)
    // This ensures the next request creates a fresh runtime with updated config
    if (updated) {
      await this.invalidateCache(characterId);
    }

    return updated || null;
  }

  async delete(id: string): Promise<void> {
    const character = await this.getById(id);
    await userCharactersRepository.delete(id);
    if (character) {
      await Promise.all([
        cache.del(CacheKeys.org.dashboard(character.organization_id)),
        this.invalidateCache(id),
      ]);
    }
  }

  async deleteForUser(characterId: string, userId: string): Promise<boolean> {
    // Verify ownership
    const character = await this.getByIdForUser(characterId, userId);
    if (!character) {
      return false;
    }

    await userCharactersRepository.delete(characterId);

    // CRITICAL: Invalidate cache after delete (including runtime cache)
    await Promise.all([
      cache.del(CacheKeys.org.dashboard(character.organization_id)),
      this.invalidateCache(characterId),
    ]);

    return true;
  }

  /**
   * Convert database character to Eliza character format
   */
  toElizaCharacter(character: UserCharacter): ElizaCharacter {
    // Extract affiliate data from character_data if present
    const characterData = character.character_data as Record<string, unknown> | undefined;
    const affiliateData = characterData?.affiliate as
      | { vibe?: string; affiliateId?: string; [key: string]: unknown }
      | undefined;

    // Also extract lore data which contains full social media posts
    const loreData = characterData?.lore as string[] | undefined;

    // Merge affiliate data AND lore into settings so it's available in the runtime
    const settings = character.settings as
      | Record<string, string | boolean | number | Record<string, unknown>>
      | undefined;
    const mergedSettings = {
      ...settings,
      // Include avatarUrl in settings for provider/runtime access (camelCase for elizaOS compatibility)
      avatarUrl: character.avatar_url ?? undefined,
      ...(affiliateData || loreData
        ? {
            affiliateData: {
              ...affiliateData,
              lore: loreData,
            },
          }
        : {}),
    };

    return {
      id: character.id,
      name: character.name,
      username: character.username ?? undefined,
      system: character.system ?? undefined,
      bio: character.bio,
      messageExamples: (() => {
        const examples = character.message_examples;
        if (
          Array.isArray(examples) &&
          examples.every(
            (ex) =>
              Array.isArray(ex) &&
              ex.every(
                (msg) =>
                  typeof msg === "object" && msg !== null && "name" in msg && "content" in msg,
              ),
          )
        ) {
          return examples as ElizaCharacter["messageExamples"];
        }
        return undefined;
      })(),
      postExamples: character.post_examples as string[] | undefined,
      topics: character.topics as string[] | undefined,
      adjectives: character.adjectives as string[] | undefined,
      documents: character.knowledge as (string | { path: string; shared?: boolean })[] | undefined,
      plugins: character.plugins as string[] | undefined,
      settings: mergedSettings as
        | Record<string, string | number | boolean | Record<string, unknown>>
        | undefined,
      secrets: character.secrets as Record<string, string | number | boolean> | undefined,
      style: character.style as
        | {
            all?: string[];
            chat?: string[];
            post?: string[];
          }
        | undefined,
      avatarUrl: character.avatar_url ?? undefined,
      isPublic: character.is_public,
    };
  }

  /**
   * Check if a character is claimable by an authenticated user.
   * A character is claimable if:
   * - It's owned by an anonymous user (affiliate-created)
   * - The owner has an affiliate email pattern
   * - The owner hasn't been converted to a real user yet
   */
  async isClaimableAffiliateCharacter(characterId: string): Promise<{
    claimable: boolean;
    ownerId?: string;
    reason?: string;
  }> {
    const character = await userCharactersRepository.findById(characterId);

    if (!character) {
      return { claimable: false, reason: "Character not found" };
    }

    // Get the owner user
    const owner = await usersService.getById(character.user_id);

    if (!owner) {
      return { claimable: false, reason: "Owner not found" };
    }

    // Check if owned by an affiliate anonymous user
    const isAffiliateUser = owner.email?.includes("@anonymous.elizacloud.ai") || false;
    const isAnonymous = owner.is_anonymous === true;

    if (isAffiliateUser && isAnonymous) {
      return {
        claimable: true,
        ownerId: owner.id,
        reason: "Affiliate character available for claiming",
      };
    }

    return {
      claimable: false,
      reason: "Character already owned by a real user",
    };
  }

  /**
   * Claim an affiliate character for an authenticated user.
   * Transfers ownership from the anonymous affiliate user to the authenticated user.
   * Also transfers room associations so the character appears in the user's library.
   */
  async claimAffiliateCharacter(
    characterId: string,
    userId: string,
    organizationId: string,
  ): Promise<{ success: boolean; message: string }> {
    // Verify character is claimable
    const claimCheck = await this.isClaimableAffiliateCharacter(characterId);

    if (!claimCheck.claimable) {
      logger.info(`[Characters] Character ${characterId} not claimable: ${claimCheck.reason}`);
      return { success: false, message: claimCheck.reason || "Not claimable" };
    }

    const previousOwnerId = claimCheck.ownerId;
    logger.info(`[Characters] 🎯 Claiming affiliate character ${characterId} for user ${userId}`, {
      previousOwnerId,
    });

    // Transfer character ownership
    const updated = await userCharactersRepository.update(characterId, {
      user_id: userId,
      organization_id: organizationId,
    });

    if (!updated) {
      return { success: false, message: "Failed to update character" };
    }

    // Transfer room associations from the previous owner to the new owner
    if (previousOwnerId) {
      const roomUpdateResult = await dbWrite
        .update(elizaRoomCharactersTable)
        .set({
          user_id: userId,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(elizaRoomCharactersTable.character_id, characterId),
            eq(elizaRoomCharactersTable.user_id, previousOwnerId),
          ),
        )
        .returning({ room_id: elizaRoomCharactersTable.room_id });

      if (roomUpdateResult.length > 0) {
        logger.info(`[Characters] Transferred ${roomUpdateResult.length} room association(s)`, {
          characterId,
          fromUserId: previousOwnerId,
          toUserId: userId,
        });
      }
    }

    logger.info(`[Characters] ✅ Successfully claimed character ${characterId}`, {
      characterName: updated.name,
      newOwnerId: userId,
      newOrgId: organizationId,
    });

    return {
      success: true,
      message: `Character "${updated.name}" has been added to your account`,
    };
  }

  // ============================================================================
  // Saved Agents Methods
  // ============================================================================

  /**
   * Get all saved agents for a user.
   * Saved agents are public agents the user has interacted with but doesn't own.
   *
   * @param userId - The ID of the user to get saved agents for
   * @returns Array of saved agents with their details and last interaction time
   */
  async getSavedAgentsForUser(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      username: string | null;
      avatar_url: string | null;
      bio: string | string[] | null;
      owner_id: string;
      owner_name: string | null;
      last_interaction_time: string;
    }>
  > {
    logger.debug("[Characters] Fetching saved agents for user:", { userId });

    // Query for distinct agents the user has chatted with
    // - entity_id = current user (messages from this user)
    // - user_id != current user (not owned by this user)
    // - is_public = true (only public agents)
    // Joins with users table to get owner's display name
    /**
     * Performance note: This query benefits from indexes on:
     * - memoryTable(entityId, agentId) - for the WHERE and JOIN
     * - userCharacters(id) - primary key, already indexed
     * - userCharacters(user_id, is_public) - for the WHERE conditions
     */
    const savedAgents = await dbRead
      .select({
        id: userCharacters.id,
        name: userCharacters.name,
        username: userCharacters.username,
        avatar_url: userCharacters.avatar_url,
        bio: userCharacters.bio,
        owner_id: userCharacters.user_id,
        owner_name: sql<string | null>`COALESCE(${users.name}, ${users.nickname})`.as("owner_name"),
        last_interaction_time: sql<string>`MAX(${memoryTable.createdAt})`.as(
          "last_interaction_time",
        ),
      })
      .from(memoryTable)
      .innerJoin(userCharacters, eq(memoryTable.agentId, userCharacters.id))
      .leftJoin(users, eq(userCharacters.user_id, users.id))
      .where(
        and(
          eq(memoryTable.entityId, userId),
          ne(userCharacters.user_id, userId),
          eq(userCharacters.is_public, true),
        ),
      )
      .groupBy(
        userCharacters.id,
        userCharacters.name,
        userCharacters.username,
        userCharacters.avatar_url,
        userCharacters.bio,
        userCharacters.user_id,
        users.name,
        users.nickname,
      )
      .orderBy(sql`MAX(${memoryTable.createdAt}) DESC`);

    logger.debug("[Characters] Found saved agents:", {
      userId,
      count: savedAgents.length,
    });

    return savedAgents;
  }

  /**
   * Get details for a specific saved agent.
   * Verifies user has access (has interacted with agent and doesn't own it).
   *
   * @param userId - The ID of the user
   * @param agentId - The ID of the agent to get details for
   * @returns Agent details with stats, or null if not found/no access
   */
  async getSavedAgentDetails(
    userId: string,
    agentId: string,
  ): Promise<{
    agent: {
      id: string;
      name: string;
      username: string | null;
      avatar_url: string | null;
      owner_id: string;
    };
    stats: {
      message_count: number;
      room_count: number;
    };
  } | null> {
    logger.debug("[Characters] Getting saved agent details:", {
      userId,
      agentId,
    });

    // Verify this is a saved agent (user doesn't own it and it's public)
    const agent = await dbRead.query.userCharacters.findFirst({
      where: and(
        eq(userCharacters.id, agentId),
        ne(userCharacters.user_id, userId),
        eq(userCharacters.is_public, true),
      ),
    });

    if (!agent) {
      return null;
    }

    // Get count of memories/messages the user has with this agent
    const messageResult = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(memoryTable)
      .where(and(eq(memoryTable.entityId, userId), eq(memoryTable.agentId, agentId)));
    const messageCount = messageResult[0]?.count ?? 0;

    // Get rooms count for this user+agent combination
    const roomResult = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(roomTable)
      .innerJoin(participantTable, eq(roomTable.id, participantTable.roomId))
      .where(and(eq(roomTable.agentId, agentId), eq(participantTable.entityId, userId)));
    const roomCount = roomResult[0]?.count ?? 0;

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        username: agent.username,
        avatar_url: agent.avatar_url,
        owner_id: agent.user_id,
      },
      stats: {
        message_count: Number(messageCount),
        room_count: Number(roomCount),
      },
    };
  }

  /**
   * Remove a saved agent from the user's list.
   * This permanently deletes:
   * - All conversation history (memories) between user and agent
   * - Room associations for user with this agent
   * - Empty rooms (rooms with no remaining participants)
   *
   * @param userId - The ID of the user
   * @param agentId - The ID of the agent to remove
   * @returns Result with success status and deletion stats, or error info
   */
  async removeSavedAgent(
    userId: string,
    agentId: string,
  ): Promise<
    | {
        success: true;
        deleted: {
          memories: number;
          participants: number;
          rooms: number;
        };
      }
    | { success: false; error: string }
  > {
    logger.info("[Characters] Removing saved agent:", { userId, agentId });

    // Verify this is a saved agent (not owned by user)
    const agent = await dbRead.query.userCharacters.findFirst({
      where: and(eq(userCharacters.id, agentId), ne(userCharacters.user_id, userId)),
    });

    if (!agent) {
      return { success: false, error: "Agent not found or you own this agent" };
    }

    // Find all rooms where this user is a participant with this agent
    const userRooms = await dbRead
      .select({ roomId: participantTable.roomId })
      .from(participantTable)
      .innerJoin(roomTable, eq(participantTable.roomId, roomTable.id))
      .where(and(eq(participantTable.entityId, userId), eq(roomTable.agentId, agentId)));

    const roomIds = userRooms
      .map((r) => r.roomId)
      .filter((roomId): roomId is string => typeof roomId === "string");

    // Use transaction to ensure atomicity of all delete operations
    const { deletedMemories, deletedParticipants, deletedRooms } = await dbWrite.transaction(
      async (tx) => {
        let memoryCount = 0;
        let participantCount = 0;
        let roomCount = 0;

        if (roomIds.length > 0) {
          // Delete memories in these rooms for this user
          // Note: We only delete memories where entityId = user.id to preserve
          // the agent's memories and other users' data
          const memoryResult = await tx
            .delete(memoryTable)
            .where(and(eq(memoryTable.entityId, userId), inArray(memoryTable.roomId, roomIds)))
            .returning({ id: memoryTable.id });
          memoryCount = memoryResult.length;

          // Delete participant records for this user in these rooms
          const participantResult = await tx
            .delete(participantTable)
            .where(
              and(eq(participantTable.entityId, userId), inArray(participantTable.roomId, roomIds)),
            )
            .returning({ id: participantTable.id });
          participantCount = participantResult.length;

          // For DM rooms (1:1), check if we should delete the room entirely
          // Only delete rooms where no other participants remain
          // PERFORMANCE: Use batch query instead of N+1 individual queries
          const roomParticipantCounts = await tx
            .select({
              roomId: participantTable.roomId,
              count: sql<number>`count(*)`.as("count"),
            })
            .from(participantTable)
            .where(inArray(participantTable.roomId, roomIds))
            .groupBy(participantTable.roomId);

          // Create a map for quick lookup
          const participantCountMap = new Map(
            roomParticipantCounts.map((r) => [r.roomId, Number(r.count)]),
          );

          // Find rooms with no remaining participants (count = 0 or not in results)
          const emptyRoomIds = roomIds.filter(
            (roomId) => !participantCountMap.has(roomId) || participantCountMap.get(roomId) === 0,
          );

          // Delete all empty rooms in a single batch query
          if (emptyRoomIds.length > 0) {
            await tx.delete(roomTable).where(inArray(roomTable.id, emptyRoomIds));
            roomCount = emptyRoomIds.length;
          }
        }

        // Also delete any memories directly tied to this agent+user combination
        // that might be in other rooms (e.g., world rooms, etc.)
        const directMemoryResult = await tx
          .delete(memoryTable)
          .where(and(eq(memoryTable.entityId, userId), eq(memoryTable.agentId, agentId)))
          .returning({ id: memoryTable.id });
        memoryCount += directMemoryResult.length;

        return {
          deletedMemories: memoryCount,
          deletedParticipants: participantCount,
          deletedRooms: roomCount,
        };
      },
    );

    logger.info("[Characters] Removed saved agent:", {
      userId,
      agentId,
      deletedMemories,
      deletedParticipants,
      deletedRooms,
    });

    return {
      success: true,
      deleted: {
        memories: deletedMemories,
        participants: deletedParticipants,
        rooms: deletedRooms,
      },
    };
  }
}

// Export singleton instance
export const charactersService = new CharactersService();
