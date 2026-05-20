/**
 * Static Data Registry
 *
 * Provides in-memory access to all static game data that doesn't change during gameplay.
 * This eliminates database queries for immutable entity properties.
 *
 * STATIC DATA (never changes during gameplay):
 * - Actor: name, description, domain, personality, tier, affiliations, postStyle, postExample, role
 * - Organization: name, ticker, description, type, canBeInvolved, initialPrice
 * - Character Mappings: real name → parody name
 * - Organization Mappings: real org → parody org
 *
 * DYNAMIC DATA (still requires DB):
 * - Actor: tradingBalance, reputationPoints, hasPool
 * - Organization: currentPrice
 * - Positions, trades, posts, etc.
 *
 * Usage:
 * ```typescript
 * import { StaticDataRegistry } from '@feed/engine';
 *
 * // Get static actor data (no DB call!)
 * const actor = StaticDataRegistry.getActor('ailon-musk');
 * console.log(actor.name, actor.tier, actor.personality);
 *
 * // Get all actors
 * const allActors = StaticDataRegistry.getAllActors();
 *
 * // Get organization
 * const org = StaticDataRegistry.getOrganization('teslai');
 * ```
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
// Default pack — imported statically since @feed/engine depends on @feed/pack-default
import {
  actors as defaultPackActors,
  manifest as defaultPackManifest,
  organizations as defaultPackOrganizations,
} from "@feed/pack-default";
import type {
  ActorTier,
  ActorTierOverrides,
  OrgCorrelation,
  PackActor,
  PackData,
  PackManifest,
  PackOrganization,
} from "@feed/shared";
import { actors as actorsData } from "../data/actors";
import { organizations as organizationsData } from "../data/organizations";

let defaultPackLoaded = false;
function tryLoadDefaultPack(registry: typeof StaticDataRegistry): void {
  if (defaultPackLoaded) return;
  defaultPackLoaded = true;
  if (defaultPackManifest && defaultPackActors && defaultPackOrganizations) {
    registry.loadPack({
      manifest: defaultPackManifest,
      actors: defaultPackActors,
      organizations: defaultPackOrganizations,
    });
  }
}

// =============================================================================
// TYPES
// =============================================================================

/**
 * Static actor data - immutable properties that don't change during gameplay
 */
export interface StaticActor {
  id: string;
  name: string;
  username?: string;
  realName?: string;
  description?: string;
  profileDescription?: string;
  domain: string[];
  ignoreTopics?: string[];
  engagementThreshold?: number;
  personality?: string;
  voice?: string;
  tier: ActorTier | null;
  affiliations: string[];
  postStyle?: string;
  postExample: string[];
  role?: string;
  initialLuck: string;
  initialMood: number;
  profileImageUrl?: string;
  isTest: boolean;
  /** Optional tier customization for alpha group mechanics */
  tierOverrides?: ActorTierOverrides;
  /** Profile picture description for image generation */
  pfpDescription?: string;
  /** Profile banner description for image generation */
  profileBanner?: string;
}

/** Organization type enum matching @feed/shared */
export type OrgType =
  | "company"
  | "media"
  | "government"
  | "vc"
  | "organization"
  | "financial";

/**
 * Static organization data - immutable properties
 */
export interface StaticOrganization {
  id: string;
  name: string;
  ticker?: string;
  description: string;
  type: OrgType;
  canBeInvolved: boolean;
  initialPrice: number | null;
  imageUrl?: string;
  originalName?: string;
  originalHandle?: string;
  /** Custom editorial style for organization posts */
  postStyle?: string;
  /** Profile picture description for image generation */
  pfpDescription?: string;
  /** Banner description for image generation */
  bannerDescription?: string;
  /** Profile description */
  profileDescription?: string;
}

/**
 * Character mapping - real name to parody name
 */
export interface CharacterMapping {
  realName: string;
  parodyName: string;
  category: string;
  aliases: string[];
  priority: number;
}

/**
 * Organization mapping - real org to parody org
 */
export interface OrganizationMapping {
  realName: string;
  parodyName: string;
  category: string;
  aliases: string[];
  priority: number;
}

// =============================================================================
// STATIC DATA REGISTRY
// =============================================================================

export class StaticDataRegistry {
  // In-memory caches
  private static actorMap: Map<string, StaticActor> | null = null;
  private static actorByUsername: Map<string, StaticActor> | null = null;
  private static actorList: StaticActor[] | null = null;
  private static orgMap: Map<string, StaticOrganization> | null = null;
  private static orgList: StaticOrganization[] | null = null;
  private static charMappings: Map<string, CharacterMapping> | null = null;
  private static orgMappings: Map<string, OrganizationMapping> | null = null;
  private static actorsByTier: Map<ActorTier | "NONE", StaticActor[]> | null =
    null;
  private static actorsByDomain: Map<string, StaticActor[]> | null = null;
  private static actorsByAffiliation: Map<string, StaticActor[]> | null = null;
  private static orgByTicker: Map<string, StaticOrganization> | null = null;

  // Pack data
  private static packManifest: PackManifest | null = null;
  private static packActors: PackActor[] = [];
  private static packOrganizations: PackOrganization[] = [];

  // ==========================================================================
  // INITIALIZATION
  // ==========================================================================

  private static initialize(): void {
    if (StaticDataRegistry.actorMap !== null) return;
    // Skip legacy initialization if pack already loaded
    if (StaticDataRegistry.packManifest) return;

    // Try to auto-load the default pack before falling back to legacy imports
    tryLoadDefaultPack(StaticDataRegistry);
    if (StaticDataRegistry.packManifest) return;

    StaticDataRegistry.actorMap = new Map();
    StaticDataRegistry.actorByUsername = new Map();
    StaticDataRegistry.actorList = [];
    StaticDataRegistry.actorsByTier = new Map([
      ["S_TIER", []],
      ["A_TIER", []],
      ["B_TIER", []],
      ["C_TIER", []],
      ["NONE", []],
    ]);
    StaticDataRegistry.actorsByDomain = new Map();

    // Load actors from TypeScript data
    for (const actor of actorsData) {
      // Use type assertion to access optional properties safely
      const actorAny = actor as {
        id: string;
        name: string;
        username?: string;
        realName?: string;
        description?: string;
        profileDescription?: string;
        domain?: string[];
        ignoreTopics?: string[];
        engagementThreshold?: number;
        personality?: string;
        voice?: string;
        tier?: string;
        affiliations?: string[];
        postStyle?: string;
        postExample?: string[];
        role?: string;
        initialLuck?: string;
        initialMood?: number;
        tierOverrides?: ActorTierOverrides;
        pfpDescription?: string;
        profileBanner?: string;
      };

      const staticActor: StaticActor = {
        id: actorAny.id,
        name: actorAny.name,
        username: actorAny.username,
        realName: actorAny.realName,
        description: actorAny.description,
        profileDescription: actorAny.profileDescription,
        domain: actorAny.domain ?? [],
        ignoreTopics: actorAny.ignoreTopics,
        engagementThreshold: actorAny.engagementThreshold,
        personality: actorAny.personality,
        voice: actorAny.voice,
        tier: (actorAny.tier as ActorTier) ?? null,
        affiliations: actorAny.affiliations ?? [],
        postStyle: actorAny.postStyle,
        postExample: actorAny.postExample ?? [],
        role: actorAny.role,
        initialLuck: actorAny.initialLuck ?? "medium",
        initialMood: actorAny.initialMood ?? 0,
        profileImageUrl: StaticDataRegistry.getActorImageUrl(actorAny.id),
        isTest: actorAny.id.startsWith("test-"),
        tierOverrides: actorAny.tierOverrides,
        pfpDescription: actorAny.pfpDescription,
        profileBanner: actorAny.profileBanner,
      };

      StaticDataRegistry.actorMap.set(actor.id, staticActor);
      StaticDataRegistry.actorList.push(staticActor);

      // Index by username for lookup by username
      if (staticActor.username) {
        StaticDataRegistry.actorByUsername.set(
          staticActor.username.toLowerCase(),
          staticActor,
        );
      }

      // Index by tier
      const tierKey = (staticActor.tier ?? "NONE") as ActorTier | "NONE";
      StaticDataRegistry.actorsByTier.get(tierKey)?.push(staticActor);

      // Index by domain
      for (const domain of staticActor.domain) {
        if (!StaticDataRegistry.actorsByDomain.has(domain)) {
          StaticDataRegistry.actorsByDomain.set(domain, []);
        }
        StaticDataRegistry.actorsByDomain.get(domain)?.push(staticActor);
      }
    }

    StaticDataRegistry.orgMap = new Map();
    StaticDataRegistry.orgList = [];

    // Load organizations from TypeScript data
    for (const org of organizationsData) {
      // Use type assertion to access optional properties safely
      const orgAny = org as {
        id: string;
        name: string;
        ticker?: string;
        description?: string;
        type?: string;
        canBeInvolved?: boolean;
        initialPrice?: number;
        originalName?: string;
        originalHandle?: string;
        postStyle?: string;
        pfpDescription?: string;
        bannerDescription?: string;
        profileDescription?: string;
      };

      const staticOrg: StaticOrganization = {
        id: orgAny.id,
        name: orgAny.name,
        ticker: orgAny.ticker,
        description: orgAny.description ?? "",
        type: (orgAny.type as OrgType) ?? "company",
        canBeInvolved: orgAny.canBeInvolved !== false,
        initialPrice: orgAny.initialPrice ?? null,
        imageUrl: StaticDataRegistry.getOrgImageUrl(orgAny.id),
        originalName: orgAny.originalName,
        originalHandle: orgAny.originalHandle,
        postStyle: orgAny.postStyle,
        pfpDescription: orgAny.pfpDescription,
        bannerDescription: orgAny.bannerDescription,
        profileDescription: orgAny.profileDescription,
      };

      StaticDataRegistry.orgMap.set(orgAny.id, staticOrg);
      StaticDataRegistry.orgList.push(staticOrg);
    }

    // Build character mappings
    StaticDataRegistry.charMappings = new Map();
    for (const actor of StaticDataRegistry.actorList) {
      if (actor.realName) {
        const mapping: CharacterMapping = {
          realName: actor.realName,
          parodyName: actor.name,
          category: StaticDataRegistry.mapDomainToCategory(actor.domain),
          aliases: StaticDataRegistry.generateActorAliases(actor),
          priority: StaticDataRegistry.mapTierToPriority(actor.tier),
        };
        StaticDataRegistry.charMappings.set(
          actor.realName.toLowerCase(),
          mapping,
        );
      }
    }

    // Build organization mappings
    StaticDataRegistry.orgMappings = new Map();
    for (const org of StaticDataRegistry.orgList) {
      if (org.originalName) {
        const mapping: OrganizationMapping = {
          realName: org.originalName,
          parodyName: org.name,
          category: StaticDataRegistry.mapOrgTypeToCategory(org.type),
          aliases: org.originalHandle ? [org.originalHandle] : [],
          priority: StaticDataRegistry.getOrganizationPriority(
            org.originalName,
            org.type,
          ),
        };
        StaticDataRegistry.orgMappings.set(
          org.originalName.toLowerCase(),
          mapping,
        );
      }
    }

    // Add fallback mappings for common social platforms not in static data
    const fallbackMappings: OrganizationMapping[] = [
      {
        realName: "Discord",
        parodyName: "DIscord",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "Reddit",
        parodyName: "AIeddit",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "LinkedIn",
        parodyName: "LinkAIdIn",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "TikTok",
        parodyName: "TikTAIk",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "Instagram",
        parodyName: "InstAIgram",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "YouTube",
        parodyName: "YoutAIbe",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "Facebook",
        parodyName: "FAIcebook",
        category: "platform",
        aliases: [],
        priority: 80,
      },
      {
        realName: "Twitter",
        parodyName: "XAI",
        category: "platform",
        aliases: ["X"],
        priority: 80,
      },
    ];

    for (const mapping of fallbackMappings) {
      const key = mapping.realName.toLowerCase();
      if (!StaticDataRegistry.orgMappings.has(key)) {
        StaticDataRegistry.orgMappings.set(key, mapping);
      }
    }
  }

  // ==========================================================================
  // PACK LOADING
  // ==========================================================================

  /**
   * Load all static data from a pack instead of legacy imports.
   * Clears existing caches and populates all internal maps from pack data.
   */
  static loadPack(pack: PackData): void {
    const { manifest, actors, organizations } = pack;

    // Store raw pack data
    StaticDataRegistry.packManifest = manifest;
    StaticDataRegistry.packActors = actors;
    StaticDataRegistry.packOrganizations = organizations;

    // Clear existing caches
    StaticDataRegistry.clearCache();

    // Re-set pack data (clearCache nulls it)
    StaticDataRegistry.packManifest = manifest;
    StaticDataRegistry.packActors = actors;
    StaticDataRegistry.packOrganizations = organizations;

    // Initialize maps
    StaticDataRegistry.actorMap = new Map();
    StaticDataRegistry.actorByUsername = new Map();
    StaticDataRegistry.actorList = [];
    StaticDataRegistry.actorsByTier = new Map([
      ["S_TIER", []],
      ["A_TIER", []],
      ["B_TIER", []],
      ["C_TIER", []],
      ["NONE", []],
    ]);
    StaticDataRegistry.actorsByDomain = new Map();

    // Load actors from pack data
    for (const packActor of actors) {
      const staticActor: StaticActor = {
        id: packActor.id,
        name: packActor.name,
        username: packActor.username,
        realName: packActor.realName,
        description: packActor.description,
        profileDescription: packActor.profileDescription,
        domain: packActor.domain ?? [],
        ignoreTopics: packActor.ignoreTopics,
        engagementThreshold: packActor.engagementThreshold,
        personality: packActor.personality,
        voice: packActor.voice,
        tier: packActor.tier ?? null,
        affiliations: packActor.affiliations ?? [],
        postStyle: packActor.postStyle,
        postExample: packActor.postExamples ?? [],
        role: undefined, // PackActor does not have a role field
        initialLuck: "medium",
        initialMood: 0,
        profileImageUrl: StaticDataRegistry.getActorImageUrl(packActor.id),
        isTest: packActor.id.startsWith("test-"),
        tierOverrides: undefined,
        pfpDescription: packActor.pfpDescription,
        profileBanner: packActor.profileBanner,
      };

      StaticDataRegistry.actorMap.set(packActor.id, staticActor);
      StaticDataRegistry.actorList.push(staticActor);

      // Index by username
      if (staticActor.username) {
        StaticDataRegistry.actorByUsername.set(
          staticActor.username.toLowerCase(),
          staticActor,
        );
      }

      // Index by tier
      const tierKey = (staticActor.tier ?? "NONE") as ActorTier | "NONE";
      StaticDataRegistry.actorsByTier.get(tierKey)?.push(staticActor);

      // Index by domain
      for (const domain of staticActor.domain) {
        if (!StaticDataRegistry.actorsByDomain.has(domain)) {
          StaticDataRegistry.actorsByDomain.set(domain, []);
        }
        StaticDataRegistry.actorsByDomain.get(domain)?.push(staticActor);
      }
    }

    // Load organizations from pack data
    StaticDataRegistry.orgMap = new Map();
    StaticDataRegistry.orgList = [];

    for (const packOrg of organizations) {
      const staticOrg: StaticOrganization = {
        id: packOrg.id,
        name: packOrg.name,
        ticker: packOrg.ticker,
        description: packOrg.description ?? "",
        type: packOrg.type ?? "company",
        canBeInvolved: packOrg.canBeInvolved !== false,
        initialPrice: packOrg.initialPrice ?? null,
        imageUrl: StaticDataRegistry.getOrgImageUrl(packOrg.id),
        originalName: packOrg.originalName,
        originalHandle: packOrg.originalHandle,
        postStyle: packOrg.postStyle,
        pfpDescription: packOrg.pfpDescription,
        bannerDescription: packOrg.bannerDescription,
        profileDescription: packOrg.profileDescription,
      };

      StaticDataRegistry.orgMap.set(packOrg.id, staticOrg);
      StaticDataRegistry.orgList.push(staticOrg);
    }

    // Build character mappings
    StaticDataRegistry.charMappings = new Map();
    for (const actor of StaticDataRegistry.actorList) {
      if (actor.realName) {
        const mapping: CharacterMapping = {
          realName: actor.realName,
          parodyName: actor.name,
          category: StaticDataRegistry.mapDomainToCategory(actor.domain),
          aliases: StaticDataRegistry.generateActorAliases(actor),
          priority: StaticDataRegistry.mapTierToPriority(actor.tier),
        };
        StaticDataRegistry.charMappings.set(
          actor.realName.toLowerCase(),
          mapping,
        );
      }
    }

    // Build organization mappings
    StaticDataRegistry.orgMappings = new Map();
    for (const org of StaticDataRegistry.orgList) {
      if (org.originalName) {
        const mapping: OrganizationMapping = {
          realName: org.originalName,
          parodyName: org.name,
          category: StaticDataRegistry.mapOrgTypeToCategory(org.type),
          aliases: org.originalHandle ? [org.originalHandle] : [],
          priority: StaticDataRegistry.getOrganizationPriority(
            org.originalName,
            org.type,
          ),
        };
        StaticDataRegistry.orgMappings.set(
          org.originalName.toLowerCase(),
          mapping,
        );
      }
    }
  }

  // ==========================================================================
  // PACK ACCESSORS
  // ==========================================================================

  /**
   * Get the loaded pack ID, or null if no pack is loaded.
   */
  static getPackId(): string | null {
    return StaticDataRegistry.packManifest?.id ?? null;
  }

  /**
   * Get rivalries from the loaded pack manifest.
   */
  static getRivalries(): [string, string][] {
    return StaticDataRegistry.packManifest?.rivalries ?? [];
  }

  /**
   * Get organization priorities from the loaded pack manifest.
   */
  static getOrgPriorities(): PackManifest["orgPriorities"] | null {
    return StaticDataRegistry.packManifest?.orgPriorities ?? null;
  }

  /**
   * Get organization correlations from the loaded pack manifest.
   */
  static getCorrelations(): OrgCorrelation[] {
    return StaticDataRegistry.packManifest?.correlations ?? [];
  }

  /**
   * Get the full pack manifest, or null if no pack is loaded.
   */
  static getPackManifest(): PackManifest | null {
    return StaticDataRegistry.packManifest;
  }

  /**
   * Get the original PackActor by ID for full character data.
   */
  static getPackActor(id: string): PackActor | undefined {
    return StaticDataRegistry.packActors.find((a) => a.id === id);
  }

  /**
   * Get the original PackOrganization by ID for full org data.
   */
  static getPackOrganization(id: string): PackOrganization | undefined {
    return StaticDataRegistry.packOrganizations.find((o) => o.id === id);
  }

  // ==========================================================================
  // ACTOR ACCESSORS
  // ==========================================================================

  /**
   * Get a static actor by ID or username - NO DATABASE CALL
   * @param identifier - Actor ID or username (case-insensitive for username)
   */
  static getActor(identifier: string): StaticActor | null {
    StaticDataRegistry.initialize();
    // First try exact ID match
    const byId = StaticDataRegistry.actorMap?.get(identifier);
    if (byId) return byId;
    // Then try username match (case-insensitive)
    return (
      StaticDataRegistry.actorByUsername?.get(identifier.toLowerCase()) ?? null
    );
  }

  /**
   * Get all static actors - NO DATABASE CALL
   */
  static getAllActors(): StaticActor[] {
    StaticDataRegistry.initialize();
    return [...(StaticDataRegistry.actorList ?? [])];
  }

  /**
   * Get actors by tier - NO DATABASE CALL
   */
  static getActorsByTier(tier: ActorTier): StaticActor[] {
    StaticDataRegistry.initialize();
    return [...(StaticDataRegistry.actorsByTier?.get(tier) ?? [])];
  }

  /**
   * Get actors by domain - NO DATABASE CALL
   */
  static getActorsByDomain(domain: string): StaticActor[] {
    StaticDataRegistry.initialize();
    return [...(StaticDataRegistry.actorsByDomain?.get(domain) ?? [])];
  }

  /**
   * Get all actor IDs - NO DATABASE CALL
   */
  static getActorIds(): string[] {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.actorList?.map((a) => a.id) ?? [];
  }

  /**
   * Get actor count - NO DATABASE CALL
   */
  static getActorCount(): number {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.actorList?.length ?? 0;
  }

  /**
   * Check if actor exists - NO DATABASE CALL
   */
  static hasActor(id: string): boolean {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.actorMap?.has(id) ?? false;
  }

  /**
   * Get random actors - NO DATABASE CALL
   */
  static getRandomActors(count: number): StaticActor[] {
    StaticDataRegistry.initialize();
    const actors = [...(StaticDataRegistry.actorList ?? [])];
    const shuffled = actors.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /**
   * Get top actors by tier (S_TIER first) - NO DATABASE CALL
   */
  static getTopActors(count: number): StaticActor[] {
    StaticDataRegistry.initialize();
    const result: StaticActor[] = [];
    const tiers: (ActorTier | "NONE")[] = [
      "S_TIER",
      "A_TIER",
      "B_TIER",
      "C_TIER",
      "NONE",
    ];

    for (const tier of tiers) {
      const tierActors = StaticDataRegistry.actorsByTier?.get(tier) ?? [];
      for (const actor of tierActors) {
        if (result.length >= count) break;
        result.push(actor);
      }
      if (result.length >= count) break;
    }

    return result;
  }

  // ==========================================================================
  // ORGANIZATION ACCESSORS
  // ==========================================================================

  /**
   * Get a static organization by ID - NO DATABASE CALL
   */
  static getOrganization(id: string): StaticOrganization | null {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.orgMap?.get(id) ?? null;
  }

  /**
   * Get all static organizations - NO DATABASE CALL
   */
  static getAllOrganizations(): StaticOrganization[] {
    StaticDataRegistry.initialize();
    return [...(StaticDataRegistry.orgList ?? [])];
  }

  /**
   * Get all organization IDs - NO DATABASE CALL
   */
  static getOrganizationIds(): string[] {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.orgList?.map((o) => o.id) ?? [];
  }

  /**
   * Get organization count - NO DATABASE CALL
   */
  static getOrganizationCount(): number {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.orgList?.length ?? 0;
  }

  /**
   * Check if organization exists - NO DATABASE CALL
   */
  static hasOrganization(id: string): boolean {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.orgMap?.has(id) ?? false;
  }

  /**
   * Get organizations by type - NO DATABASE CALL
   */
  static getOrganizationsByType(type: string): StaticOrganization[] {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.orgList?.filter((o) => o.type === type) ?? [];
  }

  /**
   * Get organization by stock ticker - NO DATABASE CALL
   * Lazy-builds the ticker index on first call.
   */
  static getOrganizationByTicker(ticker: string): StaticOrganization | null {
    StaticDataRegistry.initialize();
    if (!StaticDataRegistry.orgByTicker) {
      StaticDataRegistry.orgByTicker = new Map();
      for (const org of StaticDataRegistry.orgList ?? []) {
        if (org.ticker) {
          StaticDataRegistry.orgByTicker.set(org.ticker.toUpperCase(), org);
        }
      }
    }
    return StaticDataRegistry.orgByTicker.get(ticker.toUpperCase()) ?? null;
  }

  // ==========================================================================
  // AFFILIATION ACCESSORS
  // ==========================================================================

  /**
   * Get all actors affiliated with a specific organization - NO DATABASE CALL
   * Lazy-builds the affiliation index on first call.
   */
  static getActorsByAffiliation(orgId: string): StaticActor[] {
    StaticDataRegistry.initialize();
    if (!StaticDataRegistry.actorsByAffiliation) {
      StaticDataRegistry.actorsByAffiliation = new Map();
      for (const actor of StaticDataRegistry.actorList ?? []) {
        for (const affId of actor.affiliations) {
          const existing =
            StaticDataRegistry.actorsByAffiliation.get(affId) ?? [];
          existing.push(actor);
          StaticDataRegistry.actorsByAffiliation.set(affId, existing);
        }
      }
    }
    return [...(StaticDataRegistry.actorsByAffiliation.get(orgId) ?? [])];
  }

  /**
   * Get all organization IDs an actor is affiliated with - NO DATABASE CALL
   */
  static getActorAffiliations(actorId: string): string[] {
    const actor = StaticDataRegistry.getActor(actorId);
    return actor?.affiliations ?? [];
  }

  /**
   * Get actors affiliated with any of the given organizations - NO DATABASE CALL
   */
  static getActorsByAffiliations(orgIds: string[]): StaticActor[] {
    StaticDataRegistry.initialize();
    const seen = new Set<string>();
    const result: StaticActor[] = [];
    for (const orgId of orgIds) {
      for (const actor of StaticDataRegistry.getActorsByAffiliation(orgId)) {
        if (!seen.has(actor.id)) {
          seen.add(actor.id);
          result.push(actor);
        }
      }
    }
    return result;
  }

  // ==========================================================================
  // CHARACTER MAPPING ACCESSORS
  // ==========================================================================

  /**
   * Get parody name for a real person - NO DATABASE CALL
   */
  static getParodyName(realName: string): string | null {
    StaticDataRegistry.initialize();
    return (
      StaticDataRegistry.charMappings?.get(realName.toLowerCase())
        ?.parodyName ?? null
    );
  }

  /**
   * Get full character mapping - NO DATABASE CALL
   */
  static getCharacterMapping(realName: string): CharacterMapping | null {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.charMappings?.get(realName.toLowerCase()) ?? null;
  }

  /**
   * Get all character mappings - NO DATABASE CALL
   */
  static getAllCharacterMappings(): CharacterMapping[] {
    StaticDataRegistry.initialize();
    return [...(StaticDataRegistry.charMappings?.values() ?? [])];
  }

  // ==========================================================================
  // ORGANIZATION MAPPING ACCESSORS
  // ==========================================================================

  /**
   * Get parody name for a real organization - NO DATABASE CALL
   */
  static getParodyOrgName(realName: string): string | null {
    StaticDataRegistry.initialize();
    return (
      StaticDataRegistry.orgMappings?.get(realName.toLowerCase())?.parodyName ??
      null
    );
  }

  /**
   * Get full organization mapping - NO DATABASE CALL
   */
  static getOrganizationMapping(realName: string): OrganizationMapping | null {
    StaticDataRegistry.initialize();
    return StaticDataRegistry.orgMappings?.get(realName.toLowerCase()) ?? null;
  }

  /**
   * Get all organization mappings - NO DATABASE CALL
   */
  static getAllOrganizationMappings(): OrganizationMapping[] {
    StaticDataRegistry.initialize();
    return [...(StaticDataRegistry.orgMappings?.values() ?? [])];
  }

  // ==========================================================================
  // UTILITY FUNCTIONS
  // ==========================================================================

  /**
   * Clear all caches (useful for testing)
   */
  static clearCache(): void {
    StaticDataRegistry.actorMap = null;
    StaticDataRegistry.actorByUsername = null;
    StaticDataRegistry.actorList = null;
    StaticDataRegistry.orgMap = null;
    StaticDataRegistry.orgList = null;
    StaticDataRegistry.charMappings = null;
    StaticDataRegistry.orgMappings = null;
    StaticDataRegistry.actorsByTier = null;
    StaticDataRegistry.actorsByDomain = null;
    StaticDataRegistry.actorsByAffiliation = null;
    StaticDataRegistry.orgByTicker = null;
    StaticDataRegistry.packManifest = null;
    StaticDataRegistry.packActors = [];
    StaticDataRegistry.packOrganizations = [];
  }

  /**
   * Get statistics about loaded data
   */
  static getStats(): {
    actors: number;
    organizations: number;
    characterMappings: number;
    organizationMappings: number;
    actorsByTier: Record<string, number>;
    topDomains: Array<{ domain: string; count: number }>;
  } {
    StaticDataRegistry.initialize();

    const tierCounts: Record<string, number> = {};
    for (const [tier, actors] of StaticDataRegistry.actorsByTier?.entries() ??
      []) {
      tierCounts[tier] = actors.length;
    }

    const domainCounts: Array<{ domain: string; count: number }> = [];
    for (const [
      domain,
      actors,
    ] of StaticDataRegistry.actorsByDomain?.entries() ?? []) {
      domainCounts.push({ domain, count: actors.length });
    }
    domainCounts.sort((a, b) => b.count - a.count);

    return {
      actors: StaticDataRegistry.actorList?.length ?? 0,
      organizations: StaticDataRegistry.orgList?.length ?? 0,
      characterMappings: StaticDataRegistry.charMappings?.size ?? 0,
      organizationMappings: StaticDataRegistry.orgMappings?.size ?? 0,
      actorsByTier: tierCounts,
      topDomains: domainCounts.slice(0, 10),
    };
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private static getActorImageUrl(actorId: string): string | undefined {
    const imagePath = join(
      process.cwd(),
      "public",
      "images",
      "actors",
      `${actorId}.jpg`,
    );
    return existsSync(imagePath) ? `/images/actors/${actorId}.jpg` : undefined;
  }

  private static getOrgImageUrl(orgId: string): string | undefined {
    const imagePath = join(
      process.cwd(),
      "public",
      "images",
      "organizations",
      `${orgId}.jpg`,
    );
    return existsSync(imagePath)
      ? `/images/organizations/${orgId}.jpg`
      : undefined;
  }

  private static mapDomainToCategory(domains: string[]): string {
    if (domains.length === 0) return "general";
    if (domains.includes("crypto")) return "crypto";
    if (domains.includes("politics") || domains.includes("government"))
      return "politics";
    if (
      domains.includes("tech") ||
      domains.includes("ai") ||
      domains.includes("technology")
    )
      return "tech";
    return domains[0] ?? "general";
  }

  private static mapTierToPriority(tier: ActorTier | null): number {
    switch (tier) {
      case "S_TIER":
        return 100;
      case "A_TIER":
        return 90;
      case "B_TIER":
        return 80;
      case "C_TIER":
        return 70;
      default:
        return 50;
    }
  }

  private static mapOrgTypeToCategory(orgType: string): string {
    switch (orgType) {
      case "company":
        return "tech";
      case "media":
        return "media";
      case "government":
        return "government";
      default:
        return "general";
    }
  }

  private static getOrganizationPriority(
    orgName: string,
    orgType: string,
  ): number {
    const majorTechOrgs = [
      "OpenAI",
      "Meta",
      "Google",
      "Microsoft",
      "Apple",
      "Amazon",
      "Tesla",
      "Twitter",
      "Anthropic",
      "NVIDIA",
    ];
    if (
      majorTechOrgs.some((n) => orgName.toLowerCase().includes(n.toLowerCase()))
    )
      return 100;

    const majorCryptoOrgs = ["BinAInce", "CoinbAIse", "EtherAIum"];
    if (
      majorCryptoOrgs.some((n) =>
        orgName.toLowerCase().includes(n.toLowerCase()),
      )
    )
      return 90;

    const majorMedia = ["New York Times", "Washington Post", "CNN", "Fox News"];
    if (majorMedia.some((n) => orgName.toLowerCase().includes(n.toLowerCase())))
      return 85;

    if (orgType === "government") return 80;
    return 70;
  }

  private static generateActorAliases(actor: StaticActor): string[] {
    const aliases: string[] = [];
    // Extract last name from parody name if it has spaces
    const nameParts = actor.name.split(" ");
    if (nameParts.length > 1) {
      const lastName = nameParts[nameParts.length - 1];
      if (lastName) aliases.push(lastName);
    }
    return aliases;
  }
}

// Export convenience functions for common operations
export const getActor = StaticDataRegistry.getActor.bind(StaticDataRegistry);
export const getAllActors =
  StaticDataRegistry.getAllActors.bind(StaticDataRegistry);
export const getOrganization =
  StaticDataRegistry.getOrganization.bind(StaticDataRegistry);
export const getAllOrganizations =
  StaticDataRegistry.getAllOrganizations.bind(StaticDataRegistry);
export const getParodyName =
  StaticDataRegistry.getParodyName.bind(StaticDataRegistry);
export const getParodyOrgName =
  StaticDataRegistry.getParodyOrgName.bind(StaticDataRegistry);
