/**
 * RolodexService — the core CRM service for the agent.
 *
 * Manages contacts, information claims (with provenance), relationship
 * analytics, and categories. This is the single source of truth for
 * "what do I know about this person?"
 */

import {
  logger,
  Service,
  stringToUuid,
  type Entity,
  type IAgentRuntime,
  type Metadata,
  type Relationship,
  type UUID,
} from '@elizaos/core';

import type {
  ContactCategory,
  ContactInfo,
  ContactPreferences,
  RelationshipAnalytics,
  InformationClaim,
  InformationTier,
  ClaimScope,
  ClaimSourceContext,
  Corroboration,
  ClaimDispute,
} from '../types/index';

import { DEFAULT_HALF_LIVES } from '../types/index';
import { calculateRelationshipStrength } from '../utils/relationshipStrength';
import { computeDecayedConfidence, boostConfidenceFromCorroboration } from '../utils/timeWeighting';

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class RolodexService extends Service {
  static serviceType = 'rolodex' as const;
  capabilityDescription = 'Comprehensive contact, relationship, and knowledge management service';

  private initialized = false;

  // In-memory caches
  private contactInfoCache: Map<UUID, ContactInfo> = new Map();
  private analyticsCache: Map<string, RelationshipAnalytics> = new Map();
  private categoriesCache: ContactCategory[] = [];

  // ── Lifecycle ──────────────────────────────

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    this.categoriesCache = [
      { id: 'friend', name: 'Friend', color: '#4CAF50' },
      { id: 'family', name: 'Family', color: '#2196F3' },
      { id: 'colleague', name: 'Colleague', color: '#FF9800' },
      { id: 'acquaintance', name: 'Acquaintance', color: '#9E9E9E' },
      { id: 'vip', name: 'VIP', color: '#9C27B0' },
      { id: 'business', name: 'Business', color: '#795548' },
    ];

    await this.loadContactInfoFromComponents();
    this.initialized = true;
    logger.info('[RolodexService] Initialized');
  }

  async stop(): Promise<void> {
    this.contactInfoCache.clear();
    this.analyticsCache.clear();
    this.categoriesCache = [];
    this.initialized = false;
    logger.info('[RolodexService] Stopped');
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new RolodexService();
    await service.initialize(runtime);
    return service;
  }

  // ── Contact Management ─────────────────────

  async addContact(
    entityId: UUID,
    categories: string[] = ['acquaintance'],
    preferences?: ContactPreferences,
    customFields?: Record<string, string>
  ): Promise<ContactInfo> {
    const contactInfo: ContactInfo = {
      entityId,
      categories,
      tags: [],
      preferences: preferences ?? {},
      customFields: customFields ?? {},
      privacyLevel: 'private',
      lastModified: new Date().toISOString(),
    };

    await this.runtime.createComponent({
      id: stringToUuid(`contact-${entityId}-${this.runtime.agentId}`),
      type: 'contact_info',
      agentId: this.runtime.agentId,
      entityId,
      roomId: stringToUuid(`rolodex-${this.runtime.agentId}`),
      worldId: stringToUuid(`rolodex-world-${this.runtime.agentId}`),
      sourceEntityId: this.runtime.agentId,
      data: contactInfo as unknown as Metadata,
      createdAt: Date.now(),
    });

    this.contactInfoCache.set(entityId, contactInfo);
    logger.info(`[RolodexService] Added contact ${entityId}: ${categories.join(', ')}`);
    return contactInfo;
  }

  async updateContact(entityId: UUID, updates: Partial<ContactInfo>): Promise<ContactInfo | null> {
    const existing = await this.getContact(entityId);
    if (!existing) return null;

    const updated: ContactInfo = {
      ...existing,
      ...updates,
      entityId, // Cannot change
      lastModified: new Date().toISOString(),
    };

    const components = await this.runtime.getComponents(entityId);
    const contactComponent = components.find(
      (c) => c.type === 'contact_info' && c.agentId === this.runtime.agentId
    );

    if (contactComponent) {
      await this.runtime.updateComponent({
        ...contactComponent,
        data: updated as unknown as Metadata,
      });
    }

    this.contactInfoCache.set(entityId, updated);
    return updated;
  }

  async getContact(entityId: UUID): Promise<ContactInfo | null> {
    if (this.contactInfoCache.has(entityId)) {
      return this.contactInfoCache.get(entityId)!;
    }

    const components = await this.runtime.getComponents(entityId);
    const contactComponent = components.find(
      (c) => c.type === 'contact_info' && c.agentId === this.runtime.agentId
    );

    if (contactComponent) {
      const contactInfo = contactComponent.data as unknown as ContactInfo;
      this.contactInfoCache.set(entityId, contactInfo);
      return contactInfo;
    }

    return null;
  }

  async removeContact(entityId: UUID): Promise<boolean> {
    const components = await this.runtime.getComponents(entityId);
    const contactComponent = components.find(
      (c) => c.type === 'contact_info' && c.agentId === this.runtime.agentId
    );

    if (contactComponent) {
      await this.runtime.deleteComponent(contactComponent.id);
    }

    this.contactInfoCache.delete(entityId);
    return !!contactComponent;
  }

  async searchContacts(criteria: {
    categories?: string[];
    tags?: string[];
    searchTerm?: string;
    privacyLevel?: string;
  }): Promise<ContactInfo[]> {
    const results: ContactInfo[] = [];

    for (const [, contactInfo] of this.contactInfoCache) {
      let matches = true;

      if (criteria.categories?.length) {
        matches = matches && criteria.categories.some((cat) => contactInfo.categories.includes(cat));
      }
      if (criteria.tags?.length) {
        matches = matches && criteria.tags.some((tag) => contactInfo.tags.includes(tag));
      }
      if (criteria.privacyLevel) {
        matches = matches && contactInfo.privacyLevel === criteria.privacyLevel;
      }
      if (matches) results.push(contactInfo);
    }

    if (criteria.searchTerm) {
      const filtered: ContactInfo[] = [];
      for (const contact of results) {
        const entity = await this.runtime.getEntityById(contact.entityId);
        if (
          entity?.names.some((name) =>
            name.toLowerCase().includes(criteria.searchTerm!.toLowerCase())
          )
        ) {
          filtered.push(contact);
        }
      }
      return filtered;
    }

    return results;
  }

  // ── Information Claim Management ───────────

  /**
   * Store a new information claim about an entity.
   */
  async addClaim(params: {
    entityId: UUID;
    field: string;
    value: string;
    tier: InformationTier;
    confidence: number;
    sourceEntityId: UUID;
    sourceContext: ClaimSourceContext;
    scope?: ClaimScope;
  }): Promise<void> {
    const scope = params.scope ?? (params.tier === 'ground_truth' ? 'global' : 'platform');
    const halfLifeMs = DEFAULT_HALF_LIVES[params.tier];

    const claimId = stringToUuid(
      `claim-${params.entityId}-${params.field}-${params.value}-${this.runtime.agentId}`
    );

    // Check for existing claim with same field+value
    const components = await this.runtime.getComponents(params.entityId);
    const existing = components.find(
      (c) =>
        c.type === 'information_claim' &&
        c.data.field === params.field &&
        c.data.value === params.value
    );

    if (existing) {
      // Corroborate
      await this.corroborateClaim(params.entityId, existing.id, {
        entityId: params.sourceEntityId,
        timestamp: Date.now(),
        context: `Repeated by ${params.sourceEntityId}`,
      });
      return;
    }

    await this.runtime.createComponent({
      id: claimId,
      type: 'information_claim',
      agentId: this.runtime.agentId,
      entityId: params.entityId,
      roomId: params.sourceContext.roomId,
      worldId: stringToUuid(`rolodex-world-${this.runtime.agentId}`),
      sourceEntityId: params.sourceEntityId,
      data: {
        field: params.field,
        value: params.value,
        tier: params.tier,
        confidence: params.confidence,
        baseConfidence: params.confidence,
        sourceEntityId: params.sourceEntityId as string,
        sourceContext: {
          platform: params.sourceContext.platform,
          roomId: params.sourceContext.roomId as string,
          messageId: (params.sourceContext.messageId ?? '') as string,
          timestamp: params.sourceContext.timestamp,
        },
        corroborations: [],
        disputes: [],
        scope,
        halfLifeMs: halfLifeMs === Infinity ? -1 : halfLifeMs, // JSON can't store Infinity
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      createdAt: Date.now(),
    });
  }

  /**
   * Get all claims about an entity, with time-decayed confidence.
   */
  async getClaims(
    entityId: UUID,
    field?: string
  ): Promise<Array<{ claim: Record<string, unknown>; decayedConfidence: number }>> {
    const components = await this.runtime.getComponents(entityId);
    const claims = components.filter(
      (c) =>
        c.type === 'information_claim' &&
        c.agentId === this.runtime.agentId &&
        (field === undefined || c.data.field === field)
    );

    return claims.map((c) => {
      const halfLifeMs = c.data.halfLifeMs === -1 ? Infinity : (c.data.halfLifeMs as number);
      const corroborations = Array.isArray(c.data.corroborations)
        ? (c.data.corroborations as Array<Record<string, unknown>>)
        : [];

      // Build a minimal InformationClaim for the decay calculator
      const fakeClaim: InformationClaim = {
        id: c.id as UUID,
        entityId: c.entityId as UUID,
        field: c.data.field as string,
        value: c.data.value as string,
        tier: c.data.tier as InformationTier,
        confidence: c.data.confidence as number,
        baseConfidence: c.data.baseConfidence as number,
        sourceEntityId: c.data.sourceEntityId as UUID,
        sourceContext: c.data.sourceContext as unknown as ClaimSourceContext,
        corroborations: corroborations as unknown as Corroboration[],
        disputes: (c.data.disputes ?? []) as unknown as ClaimDispute[],
        scope: c.data.scope as ClaimScope,
        halfLifeMs,
        createdAt: c.data.createdAt as number,
        updatedAt: c.data.updatedAt as number,
      };

      return {
        claim: c.data,
        decayedConfidence: computeDecayedConfidence(fakeClaim),
      };
    });
  }

  /**
   * Add a corroboration to an existing claim.
   */
  async corroborateClaim(
    entityId: UUID,
    componentId: UUID,
    corroboration: Corroboration
  ): Promise<void> {
    const components = await this.runtime.getComponents(entityId);
    const claim = components.find((c) => c.id === componentId);
    if (!claim) return;

    const corroborations = Array.isArray(claim.data.corroborations)
      ? (claim.data.corroborations as Array<Record<string, unknown>>)
      : [];

    corroborations.push({
      entityId: corroboration.entityId as string,
      timestamp: corroboration.timestamp,
      context: corroboration.context,
    });

    const currentBase = (claim.data.baseConfidence as number) ?? 0.5;
    const newBase = boostConfidenceFromCorroboration(currentBase, corroborations.length);

    await this.runtime.updateComponent({
      ...claim,
      data: {
        ...claim.data,
        corroborations,
        baseConfidence: newBase,
        confidence: newBase,
        updatedAt: Date.now(),
      },
    });
  }

  // ── Relationship Analytics ─────────────────

  async analyzeRelationship(
    sourceEntityId: UUID,
    targetEntityId: UUID
  ): Promise<RelationshipAnalytics | null> {
    const cacheKey = `${sourceEntityId}-${targetEntityId}`;
    const cached = this.analyticsCache.get(cacheKey);
    if (cached?.lastInteractionAt) {
      const age = Date.now() - new Date(cached.lastInteractionAt).getTime();
      if (age < 3_600_000) return cached; // 1 hour cache
    }

    const relationships = await this.runtime.getRelationships({ entityIds: [sourceEntityId] });
    const relationship = relationships.find(
      (r) => r.targetEntityId === targetEntityId || r.sourceEntityId === targetEntityId
    );

    if (!relationship) return null;

    const messages = await this.runtime.getMemories({
      tableName: 'messages',
      entityId: sourceEntityId,
      count: 100,
    });

    const interactions = messages.filter(
      (m) =>
        m.content?.inReplyTo === targetEntityId ||
        (m.entityId === targetEntityId && m.content?.inReplyTo === sourceEntityId)
    );

    const interactionCount = interactions.length;
    const lastInteraction = interactions[0];
    const lastInteractionAt = lastInteraction?.createdAt
      ? new Date(lastInteraction.createdAt).toISOString()
      : undefined;

    // Average response time
    let totalResponseTime = 0;
    let responseCount = 0;
    for (let i = 0; i < interactions.length - 1; i++) {
      const current = interactions[i];
      const next = interactions[i + 1];
      if (current.entityId !== next.entityId && current.createdAt && next.createdAt) {
        totalResponseTime += new Date(next.createdAt).getTime() - new Date(current.createdAt).getTime();
        responseCount++;
      }
    }

    const relationshipType = (relationship.metadata?.relationshipType as string) ?? 'acquaintance';

    const strength = calculateRelationshipStrength({
      interactionCount,
      lastInteractionAt,
      relationshipType,
    });

    const analytics: RelationshipAnalytics = {
      strength,
      interactionCount,
      lastInteractionAt,
      averageResponseTime: responseCount > 0 ? totalResponseTime / responseCount : undefined,
      sentimentScore: undefined,
      topicsDiscussed: [],
    };

    this.analyticsCache.set(cacheKey, analytics);
    return analytics;
  }

  async getRelationshipInsights(entityId: UUID): Promise<{
    strongestRelationships: Array<{ entity: Entity; analytics: RelationshipAnalytics }>;
    needsAttention: Array<{ entity: Entity; daysSinceContact: number }>;
    recentInteractions: Array<{ entity: Entity; lastInteraction: string }>;
  }> {
    const relationships = await this.runtime.getRelationships({ entityIds: [entityId] });
    const insights = {
      strongestRelationships: [] as Array<{ entity: Entity; analytics: RelationshipAnalytics }>,
      needsAttention: [] as Array<{ entity: Entity; daysSinceContact: number }>,
      recentInteractions: [] as Array<{ entity: Entity; lastInteraction: string }>,
    };

    for (const rel of relationships) {
      const targetId = rel.sourceEntityId === entityId ? rel.targetEntityId : rel.sourceEntityId;
      const entity = await this.runtime.getEntityById(targetId);
      if (!entity) continue;

      const analytics = await this.analyzeRelationship(entityId, targetId);
      if (!analytics) continue;

      if (analytics.strength > 70) {
        insights.strongestRelationships.push({ entity, analytics });
      }

      if (analytics.lastInteractionAt) {
        const daysSince =
          (Date.now() - new Date(analytics.lastInteractionAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 30) {
          insights.needsAttention.push({ entity, daysSinceContact: Math.round(daysSince) });
        }
        if (daysSince < 7) {
          insights.recentInteractions.push({ entity, lastInteraction: analytics.lastInteractionAt });
        }
      }
    }

    insights.strongestRelationships.sort((a, b) => b.analytics.strength - a.analytics.strength);
    insights.needsAttention.sort((a, b) => b.daysSinceContact - a.daysSinceContact);
    insights.recentInteractions.sort(
      (a, b) => new Date(b.lastInteraction).getTime() - new Date(a.lastInteraction).getTime()
    );

    return insights;
  }

  // ── Category Management ────────────────────

  async getCategories(): Promise<ContactCategory[]> {
    return this.categoriesCache;
  }

  async addCategory(category: ContactCategory): Promise<void> {
    if (this.categoriesCache.find((c) => c.id === category.id)) {
      throw new Error(`Category ${category.id} already exists`);
    }
    this.categoriesCache.push(category);
  }

  // ── Privacy Management ─────────────────────

  async setContactPrivacy(
    entityId: UUID,
    privacyLevel: 'public' | 'private' | 'restricted'
  ): Promise<boolean> {
    const contact = await this.getContact(entityId);
    if (!contact) return false;
    await this.updateContact(entityId, { privacyLevel });
    return true;
  }

  async canAccessContact(requestingEntityId: UUID, targetEntityId: UUID): Promise<boolean> {
    const contact = await this.getContact(targetEntityId);
    if (!contact) return false;
    if (requestingEntityId === this.runtime.agentId) return true;

    switch (contact.privacyLevel) {
      case 'public':
        return true;
      case 'private':
        return requestingEntityId === targetEntityId;
      case 'restricted':
        return false;
      default:
        return false;
    }
  }

  // ── Private ────────────────────────────────

  private async loadContactInfoFromComponents(): Promise<void> {
    try {
      const rooms = await this.runtime.getRooms(stringToUuid(`world-${this.runtime.agentId}`));
      const entityIds = new Set<UUID>();

      for (const room of rooms) {
        const entities = await this.runtime.getEntitiesForRoom(room.id, true);
        for (const entity of entities) {
          entityIds.add(entity.id as UUID);
        }
      }

      for (const entityId of entityIds) {
        const components = await this.runtime.getComponents(entityId);
        const contactComponent = components.find(
          (c) => c.type === 'contact_info' && c.agentId === this.runtime.agentId
        );
        if (contactComponent) {
          this.contactInfoCache.set(entityId, contactComponent.data as unknown as ContactInfo);
        }
      }

      logger.info(`[RolodexService] Loaded ${this.contactInfoCache.size} contacts`);
    } catch (error) {
      logger.error(
        '[RolodexService] Error loading contacts:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
