/**
 * Pack Types
 *
 * A "pack" is a self-contained simulation universe: actors, organizations,
 * relationships, correlations, and configuration. The engine loads one pack
 * at a time. Packs are swappable — the default Feed parody universe is
 * one pack; a "30 Under 30 scammer CEOs" universe is another.
 */

import type { ActorTier } from './game-types';

// =============================================================================
// Pack Manifest
// =============================================================================

/**
 * Top-level pack configuration. Defines the universe: who's in it,
 * how they relate, and any config overrides for the engine.
 */
export interface PackManifest {
  /** Unique pack identifier, e.g. "feed-default", "corporate-30-under-30" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description of the pack's premise */
  description: string;
  /** Semver version */
  version: string;
  /** Overall tone of the simulation */
  tone: 'satirical' | 'serious' | 'mixed';
  /** One-liner premise, e.g. "Crypto parody universe" */
  premise: string;

  // ---------------------------------------------------------------------------
  // Content IDs (actors and organizations are loaded separately)
  // ---------------------------------------------------------------------------

  /** All actor IDs in this pack */
  actorIds: string[];
  /** All organization IDs in this pack */
  organizationIds: string[];

  // ---------------------------------------------------------------------------
  // Relationships
  // ---------------------------------------------------------------------------

  /** Actor rivalry pairs (by ID). Replaces hardcoded KNOWN_RIVALRIES. */
  rivalries: [string, string][];

  /** Organization priority tiers. Replaces hardcoded majorTechOrgs, etc. */
  orgPriorities: {
    /** Highest-priority orgs (equivalent to "major tech/crypto") */
    major: string[];
    /** Mid-priority orgs */
    secondary: string[];
    /** Media organizations */
    media: string[];
  };

  /** Inter-organization correlations (supply chains, competitors, etc.) */
  correlations: OrgCorrelation[];

  // ---------------------------------------------------------------------------
  // Optional config overrides (engine uses defaults when absent)
  // ---------------------------------------------------------------------------

  /** Override capital allocation rules */
  capitalAllocation?: {
    /** Starting balance per tier, e.g. { S_TIER: 250000, A_TIER: 75000 } */
    tierAmounts?: Record<string, number>;
    /** Role-keyword multipliers, e.g. { ceo: 2.0, journalist: 0.8 } */
    roleMultipliers?: Record<string, number>;
    /** Domain multipliers, e.g. { finance: 1.5, tech: 1.2 } */
    domainMultipliers?: Record<string, number>;
  };

  /** Override NPC activity config (partial merge with engine defaults) */
  activityOverrides?: Record<string, unknown>;
}

// =============================================================================
// Pack Actor (Unified: Eliza Character + Game ActorData + Behavioral Metadata)
// =============================================================================

/**
 * A single actor in a pack. Combines:
 * - Eliza Character fields (system prompt, bio, lore, style, examples)
 * - Engine ActorData fields (tier, domain, affiliations, voice)
 * - Feed behavioral metadata (alignment, team, trading style, autonomy)
 *
 * This is the single source of truth for an NPC's identity, personality,
 * and behavioral configuration.
 */
export interface PackActor {
  // ---------------------------------------------------------------------------
  // Eliza Character fields
  // ---------------------------------------------------------------------------

  /** Unique actor ID, e.g. "ailon-musk" or "chad-sterling" */
  id: string;
  /** Display name */
  name: string;
  /** Social handle (without @) */
  username: string;
  /** Full system prompt for LLM context */
  system: string;
  /** Biography lines (array for flexibility) */
  bio: string[];
  /** Lore / background / backstory */
  lore: string[];
  /** Primary topics this actor engages with */
  topics: string[];
  /** Descriptive adjectives for the character */
  adjectives: string[];
  /** Voice/style rules for content generation */
  style: {
    /** Rules that apply everywhere */
    all: string[];
    /** Rules specific to chat/comments */
    chat: string[];
    /** Rules specific to social posts */
    post: string[];
  };
  /** Example conversations for Eliza training */
  messageExamples: Array<Array<{ user: string; content: { text: string } }>>;
  /** Example posts demonstrating voice */
  postExamples: string[];
  /** LLM model and generation settings */
  settings: {
    model?: string;
    temperature: number;
    maxTokens: number;
    groq?: {
      primary?: string;
      small?: string;
      large?: string;
    };
  };

  // ---------------------------------------------------------------------------
  // Engine / Game fields (from ActorData)
  // ---------------------------------------------------------------------------

  /** Actor tier for capital allocation and game weighting */
  tier: ActorTier;
  /** Domain expertise areas */
  domain: string[];
  /** Organization IDs this actor is affiliated with */
  affiliations: string[];
  /** General personality type (maps to LLM temperature, posting style) */
  personality: string;
  /** How they speak — verbal patterns, tone, sentence structure */
  voice: string;
  /** Style guide for post generation */
  postStyle: string;
  /** Primary description */
  description: string;
  /** What the actor says about themselves on their profile */
  profileDescription?: string;
  /** Topics this actor explicitly ignores */
  ignoreTopics?: string[];
  /** Minimum engagement threshold (0-1) for off-domain topics */
  engagementThreshold?: number;
  /** Can run a trading pool */
  hasPool?: boolean;
  /** Profile picture description (for image generation) */
  pfpDescription: string;
  /** Banner/header description (for image generation) */
  profileBanner?: string;

  // ---------------------------------------------------------------------------
  // Feed behavioral metadata
  // ---------------------------------------------------------------------------

  feed: {
    /** Moral alignment */
    alignment: 'good' | 'neutral' | 'evil';
    /** Team assignment for trust/scam benchmarks */
    team: 'blue' | 'red' | 'gray';
    /** Scam detection profile */
    scamProfile: string;
    /** Competence level */
    competence: string;
    /** How they trade (description) */
    tradingStyle: string;
    /** How they interact socially (description) */
    socialStyle: string;
    /** Which autonomous features are enabled */
    autonomy: {
      trading: boolean;
      posting: boolean;
      commenting: boolean;
      dms: boolean;
      groups: boolean;
    };
    /** Tags for RL training dataset filtering */
    datasetTags: string[];

    // Optional extended fields
    politics?: string;
    gender?: string;
    motivations?: string[];
    fears?: string[];
    caution?: string;
    deception?: string;
  };

  // ---------------------------------------------------------------------------
  // Identity mapping (for parody / AI-avatar packs)
  // ---------------------------------------------------------------------------

  /** Original real-world name (e.g. "Elon Musk" for "AIlon Musk") */
  realName?: string;
  originalFirstName?: string;
  originalLastName?: string;
  originalHandle?: string;
  firstName?: string;
  lastName?: string;
}

// =============================================================================
// Pack Organization
// =============================================================================

/**
 * An organization in a pack. Companies, media outlets, VCs, governments.
 */
export interface PackOrganization {
  id: string;
  name: string;
  ticker?: string;
  description: string;
  profileDescription?: string;
  type:
    | 'company'
    | 'media'
    | 'government'
    | 'vc'
    | 'organization'
    | 'financial';
  canBeInvolved: boolean;
  initialPrice?: number;
  postStyle?: string;
  postExample?: string[];
  pfpDescription?: string;
  bannerDescription?: string;
  username?: string;
  originalName?: string;
  originalHandle?: string;
}

// =============================================================================
// Organization Correlation
// =============================================================================

/**
 * A directional relationship between two organizations.
 * Strength is -1 (strong negative correlation) to 1 (strong positive).
 */
export interface OrgCorrelation {
  orgId: string;
  relatedOrgId: string;
  type: 'supplier' | 'competitor' | 'partner' | 'investor' | 'subsidiary';
  /** -1 to 1. Negative = inverse correlation (competitors), positive = co-movement */
  strength: number;
}

// =============================================================================
// Pack Data (full loaded pack)
// =============================================================================

/**
 * A fully loaded pack ready to be consumed by the engine.
 */
export interface PackData {
  manifest: PackManifest;
  actors: PackActor[];
  organizations: PackOrganization[];
}
