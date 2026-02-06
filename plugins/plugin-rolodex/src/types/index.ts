/**
 * plugin-rolodex shared types
 *
 * All types used across the rolodex plugin are defined here so that
 * services, evaluators, providers, actions, and tests share a single
 * source of truth.
 */

import type { UUID, Entity, Relationship } from '@elizaos/core';

// ──────────────────────────────────────────────
// Information Tier System
// ──────────────────────────────────────────────

/**
 * The four tiers of information confidence.
 *
 *  ground_truth  – came from a platform API or verified source
 *  self_reported – the person said it about themselves, in a specific context
 *  hearsay       – someone else said it about them
 *  inferred      – the agent figured it out from evidence
 */
export type InformationTier = 'ground_truth' | 'self_reported' | 'hearsay' | 'inferred';

/**
 * Where a claim is considered valid.
 *
 *  global   – universally true  (e.g. a verified wallet address)
 *  platform – true on the platform where it was stated
 *  room     – true only in the room it was mentioned
 */
export type ClaimScope = 'global' | 'platform' | 'room';

/**
 * The context in which a claim was made.
 */
export interface ClaimSourceContext {
  platform: string;
  roomId: UUID;
  messageId?: UUID;
  timestamp: number;
}

/**
 * A corroboration is someone else confirming the same claim.
 */
export interface Corroboration {
  entityId: UUID;
  timestamp: number;
  context: string;
}

/**
 * A dispute is someone contradicting a claim.
 */
export interface ClaimDispute {
  entityId: UUID;
  alternativeValue: string;
  timestamp: number;
  context: string;
  resolved: boolean;
  resolution?: 'accepted' | 'rejected';
}

/**
 * An InformationClaim is the atomic unit of knowledge the agent stores
 * about entities. Every piece of information has provenance, confidence,
 * scope, and a decay half-life.
 */
export interface InformationClaim {
  id: UUID;
  /** The entity this claim is *about* */
  entityId: UUID;
  /** What kind of information (e.g. 'twitter_handle', 'birthday', 'role') */
  field: string;
  /** The actual value */
  value: string;
  /** Knowledge tier */
  tier: InformationTier;
  /** Current confidence 0-1, decays over time */
  confidence: number;
  /** Base confidence before decay (set when created/corroborated) */
  baseConfidence: number;
  /** Who provided this information */
  sourceEntityId: UUID;
  /** Where/when it was provided */
  sourceContext: ClaimSourceContext;
  /** Others who confirmed it – each corroboration doubles the half-life */
  corroborations: Corroboration[];
  /** Others who disputed it */
  disputes: ClaimDispute[];
  /** Where this claim is considered valid */
  scope: ClaimScope;
  /** Half-life in milliseconds – confidence halves after this duration */
  halfLifeMs: number;
  createdAt: number;
  updatedAt: number;
}

// ──────────────────────────────────────────────
// Entity Resolution / Cross-Platform Identity
// ──────────────────────────────────────────────

/**
 * A signal that contributes to the confidence that two entities are the
 * same person.
 */
export interface ResolutionSignal {
  type: ResolutionSignalType;
  weight: number;
  evidence: string;
  timestamp: number;
}

export type ResolutionSignalType =
  | 'name_match'
  | 'handle_correlation'
  | 'project_affinity'
  | 'shared_connections'
  | 'temporal_proximity'
  | 'self_identification'
  | 'admin_confirmation'
  | 'llm_inference';

/**
 * A link between two entities that the agent believes (with some
 * confidence) are the same person.
 */
export interface EntityLink {
  id: UUID;
  entityA: UUID;
  entityB: UUID;
  confidence: number;
  status: EntityLinkStatus;
  signals: ResolutionSignal[];
  /** Who or what created this link */
  proposedBy: 'system' | UUID;
  confirmedBy?: UUID;
  rejectedBy?: UUID;
  /** The merge task ID if one was created */
  mergeTaskId?: UUID;
  createdAt: number;
  updatedAt: number;
}

export type EntityLinkStatus = 'proposed' | 'confirmed' | 'rejected' | 'merged';

/**
 * A candidate pair returned by the candidate generator.
 */
export interface ResolutionCandidate {
  entityA: UUID;
  entityB: UUID;
  /** Raw signals before scoring */
  signals: ResolutionSignal[];
  /** Combined score 0-1 */
  score: number;
}

// ──────────────────────────────────────────────
// Relationship Lifecycle
// ──────────────────────────────────────────────

/**
 * Relationship types the agent can detect.
 */
export type RelationshipType =
  | 'friend'
  | 'colleague'
  | 'family'
  | 'community'
  | 'acquaintance'
  | 'mentor'
  | 'adversarial';

/**
 * A snapshot of a relationship at a point in time, used to track
 * evolution.
 */
export interface RelationshipSnapshot {
  type: RelationshipType;
  strength: number;
  sentiment: 'positive' | 'negative' | 'neutral';
  timestamp: number;
}

/**
 * Extended relationship metadata tracked by the rolodex.
 */
export interface RolodexRelationshipMetadata {
  relationshipType: RelationshipType;
  sentiment: 'positive' | 'negative' | 'neutral';
  strength: number;
  interactionCount: number;
  lastInteractionAt: string;
  /** Snapshots for evolution tracking */
  history: RelationshipSnapshot[];
  /** Half-life for decay in ms (default 30 days) */
  decayHalfLifeMs: number;
  /** Base strength before decay */
  baseStrength: number;
  /** When strength was last recalculated */
  lastDecayAt: number;
  autoDetected: boolean;
}

// ──────────────────────────────────────────────
// LLM Extraction Output Schemas
// ──────────────────────────────────────────────

/**
 * What the LLM returns when analyzing a conversation for relationships.
 */
export interface ExtractionResult {
  platformIdentities: ExtractedIdentity[];
  relationships: ExtractedRelationship[];
  mentionedPeople: ExtractedMention[];
  disputes: ExtractedDispute[];
  privacyBoundaries: ExtractedPrivacy[];
  trustSignals: ExtractedTrustSignal[];
}

export interface ExtractedIdentity {
  platform: string;
  handle: string;
  /** Who this identity belongs to (name or reference to speaker) */
  belongsTo: string;
  /** How confident the LLM is */
  confidence: number;
  /** 'self' if the person said it about themselves, 'other' if someone else */
  reportedBy: 'self' | 'other';
}

export interface ExtractedRelationship {
  personA: string;
  personB: string;
  type: RelationshipType;
  sentiment: 'positive' | 'negative' | 'neutral';
  confidence: number;
  evidence: string;
}

export interface ExtractedMention {
  name: string;
  context: string;
  attributes: Record<string, string>;
  /** Whether this person is a participant or a third party */
  isParticipant: boolean;
}

export interface ExtractedDispute {
  /** Who is disputing */
  disputer: string;
  /** Whose information is being disputed */
  about: string;
  /** What field is being disputed */
  field: string;
  /** The existing value being challenged */
  existingValue: string;
  /** The proposed replacement */
  proposedValue: string;
  confidence: number;
}

export interface ExtractedPrivacy {
  /** Who requested privacy */
  requestedBy: string;
  /** What should be kept private */
  content: string;
  /** Who it should be hidden from ('everyone', a specific name, etc.) */
  hiddenFrom: string;
  confidence: number;
}

export interface ExtractedTrustSignal {
  entityName: string;
  signal: 'helpful' | 'suspicious' | 'authoritative' | 'deceptive' | 'neutral';
  evidence: string;
  severity: number;
}

// ──────────────────────────────────────────────
// Contact System (existing, cleaned up)
// ──────────────────────────────────────────────

export interface ContactCategory {
  id: string;
  name: string;
  description?: string;
  color?: string;
}

export interface ContactPreferences {
  preferredCommunicationChannel?: string;
  timezone?: string;
  language?: string;
  contactFrequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  doNotDisturb?: boolean;
  notes?: string;
}

export interface ContactInfo {
  entityId: UUID;
  categories: string[];
  tags: string[];
  preferences: ContactPreferences;
  customFields: Record<string, string>;
  privacyLevel: 'public' | 'private' | 'restricted';
  lastModified: string;
}

export interface RelationshipAnalytics {
  strength: number;
  interactionCount: number;
  lastInteractionAt?: string;
  averageResponseTime?: number;
  sentimentScore?: number;
  topicsDiscussed: string[];
}

export interface FollowUpSuggestion {
  entityId: UUID;
  entityName: string;
  reason: string;
  daysSinceLastContact: number;
  relationshipStrength: number;
  suggestedMessage?: string;
}

// ──────────────────────────────────────────────
// Default constants
// ──────────────────────────────────────────────

/** Default half-lives per information tier (in milliseconds) */
export const DEFAULT_HALF_LIVES: Record<InformationTier, number> = {
  ground_truth: Infinity,
  self_reported: 90 * 24 * 60 * 60 * 1000, // 90 days
  hearsay: 30 * 24 * 60 * 60 * 1000, // 30 days
  inferred: 14 * 24 * 60 * 60 * 1000, // 14 days
};

/** Default half-life for relationship decay (30 days) */
export const DEFAULT_RELATIONSHIP_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

/** Confidence thresholds for entity resolution */
export const RESOLUTION_THRESHOLDS = {
  /** Below this, discard the candidate */
  DISCARD: 0.15,
  /** Above this, create a merge task for review */
  PROPOSE: 0.35,
  /** Above this, auto-confirm the link (still creates a task for record) */
  AUTO_CONFIRM: 0.85,
} as const;

/** Weights for each resolution signal type */
export const SIGNAL_WEIGHTS: Record<ResolutionSignalType, number> = {
  name_match: 0.15,
  handle_correlation: 0.25,
  project_affinity: 0.15,
  shared_connections: 0.10,
  temporal_proximity: 0.05,
  self_identification: 0.30,
  admin_confirmation: 1.0,
  llm_inference: 0.20,
};
