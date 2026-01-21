import {
  type Entity,
  type IAgentRuntime,
  type JsonValue,
  logger,
  type Metadata,
  type MetadataValue,
  type Relationship,
  Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";

// Extended Relationship interface with new fields
interface ExtendedRelationship extends Relationship {
  relationshipType?: string;
  strength?: number;
  lastInteractionAt?: string;
  nextFollowUpAt?: string;
}

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
  contactFrequency?: "daily" | "weekly" | "monthly" | "quarterly";
  doNotDisturb?: boolean;
  notes?: string;
  /** Index signature for metadata compatibility */
  [key: string]: string | boolean | undefined;
}

export interface ContactInfo {
  entityId: UUID;
  categories: string[];
  tags: string[];
  preferences: ContactPreferences;
  customFields: Record<string, JsonValue>;
  privacyLevel: "public" | "private" | "restricted";
  lastModified: string;
}

/** Helper to convert ContactInfo to Metadata for storage */
function contactInfoToMetadata(contactInfo: ContactInfo): Metadata {
  return {
    entityId: contactInfo.entityId,
    categories: contactInfo.categories,
    tags: contactInfo.tags,
    preferences: contactInfo.preferences as MetadataValue,
    customFields: contactInfo.customFields,
    privacyLevel: contactInfo.privacyLevel,
    lastModified: contactInfo.lastModified,
  };
}

/** Helper to convert Metadata back to ContactInfo */
function metadataToContactInfo(data: Metadata): ContactInfo {
  return {
    entityId: data.entityId as UUID,
    categories: data.categories as string[],
    tags: data.tags as string[],
    preferences: data.preferences as ContactPreferences,
    customFields: (data.customFields as Record<string, JsonValue>) ?? {},
    privacyLevel: data.privacyLevel as "public" | "private" | "restricted",
    lastModified: data.lastModified as string,
  };
}

export interface RelationshipAnalytics {
  strength: number;
  interactionCount: number;
  lastInteractionAt?: string;
  averageResponseTime?: number;
  sentimentScore?: number;
  topicsDiscussed: string[];
}

export interface FollowUpSchedule {
  entityId: UUID;
  scheduledAt: string;
  reason: string;
  priority: "high" | "medium" | "low";
  completed: boolean;
  taskId?: UUID;
}

// Entity lifecycle event types
export enum EntityLifecycleEvent {
  CREATED = "entity:created",
  UPDATED = "entity:updated",
  MERGED = "entity:merged",
  RESOLVED = "entity:resolved",
}

export interface EntityEventData {
  entity: Entity;
  previousEntity?: Entity;
  mergedEntities?: Entity[];
  source?: string;
  confidence?: number;
}

/**
 * Calculate relationship strength based on interaction patterns
 */
export function calculateRelationshipStrength({
  interactionCount,
  lastInteractionAt,
  messageQuality = 5,
  relationshipType = "acquaintance",
}: {
  interactionCount: number;
  lastInteractionAt?: string;
  messageQuality?: number;
  relationshipType?: string;
}): number {
  // Base score from interaction count (max 40 points)
  const interactionScore = Math.min(interactionCount * 2, 40);

  // Recency score (max 30 points)
  let recencyScore = 0;
  if (lastInteractionAt) {
    const daysSinceLastInteraction =
      (Date.now() - new Date(lastInteractionAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysSinceLastInteraction < 1) recencyScore = 30;
    else if (daysSinceLastInteraction < 7) recencyScore = 25;
    else if (daysSinceLastInteraction < 30) recencyScore = 20;
    else if (daysSinceLastInteraction < 90) recencyScore = 10;
    else recencyScore = 5;
  }

  // Quality score (max 20 points)
  const qualityScore = (messageQuality / 10) * 20;

  // Relationship type bonus (max 10 points)
  const relationshipBonus: Record<string, number> = {
    family: 10,
    friend: 8,
    colleague: 6,
    acquaintance: 4,
    unknown: 0,
  };

  // Calculate total strength
  const totalStrength =
    interactionScore +
    recencyScore +
    qualityScore +
    (relationshipBonus[relationshipType] ?? 0);

  // Return clamped value between 0 and 100
  return Math.max(0, Math.min(100, Math.round(totalStrength)));
}

export class RolodexService extends Service {
  static serviceType = "rolodex" as const;

  capabilityDescription =
    "Comprehensive contact and relationship management service";

  // In-memory caches for performance
  private contactInfoCache: Map<UUID, ContactInfo> = new Map();
  private analyticsCache: Map<string, RelationshipAnalytics> = new Map();
  private categoriesCache: ContactCategory[] = [];
  private static readonly CONTACT_CACHE_LIMIT = 2000;
  private static readonly ANALYTICS_CACHE_LIMIT = 2000;

  private setCacheWithLimit<K, V>(
    cache: Map<K, V>,
    key: K,
    value: V,
    limit: number,
  ): void {
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, value);
    if (cache.size > limit) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;

    // Initialize default categories
    this.categoriesCache = [
      { id: "friend", name: "Friend", color: "#4CAF50" },
      { id: "family", name: "Family", color: "#2196F3" },
      { id: "colleague", name: "Colleague", color: "#FF9800" },
      { id: "acquaintance", name: "Acquaintance", color: "#9E9E9E" },
      { id: "vip", name: "VIP", color: "#9C27B0" },
      { id: "business", name: "Business", color: "#795548" },
    ];

    // Load existing contact info from components
    await this.loadContactInfoFromComponents();

    // Service initialized
    logger.info("[RolodexService] Initialized successfully");
  }

  async stop(): Promise<void> {
    // Clean up caches
    this.contactInfoCache.clear();
    this.analyticsCache.clear();
    this.categoriesCache = [];
    // Service stopped
    logger.info("[RolodexService] Stopped successfully");
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new RolodexService();
    await service.initialize(runtime);
    return service;
  }

  private async loadContactInfoFromComponents(): Promise<void> {
    // Get all rooms for the agent to find entities
    const rooms = await this.runtime.getRooms(
      stringToUuid(`world-${this.runtime.agentId}`),
    );
    const entityIds = new Set<UUID>();

    // Collect unique entity IDs from all rooms
    for (const room of rooms) {
      const entities = await this.runtime.getEntitiesForRoom(room.id, true);
      for (const entity of entities) {
        entityIds.add(entity.id as UUID);
      }
    }

    // Load contact info from components for each entity
    for (const entityId of entityIds) {
      const components = await this.runtime.getComponents(entityId);
      const contactComponent = components.find(
        (c) => c.type === "contact_info" && c.agentId === this.runtime.agentId,
      );

      if (contactComponent?.data) {
        const contactInfo = metadataToContactInfo(
          contactComponent.data as Metadata,
        );
        this.setCacheWithLimit(
          this.contactInfoCache,
          entityId,
          contactInfo,
          RolodexService.CONTACT_CACHE_LIMIT,
        );
      }
    }

    logger.info(
      `[RolodexService] Loaded ${this.contactInfoCache.size} contacts from components`,
    );
  }

  // Contact Management Methods
  async addContact(
    entityId: UUID,
    categories: string[] = ["acquaintance"],
    preferences?: ContactPreferences,
    customFields?: Record<string, JsonValue>,
  ): Promise<ContactInfo> {
    const contactInfo: ContactInfo = {
      entityId,
      categories,
      tags: [],
      preferences: preferences ?? {},
      customFields: customFields ?? ({} as Record<string, JsonValue>),
      privacyLevel: "private",
      lastModified: new Date().toISOString(),
    };

    // Save as component
    await this.runtime.createComponent({
      id: stringToUuid(`contact-${entityId}-${this.runtime.agentId}`),
      type: "contact_info",
      agentId: this.runtime.agentId,
      entityId,
      roomId: stringToUuid(`rolodex-${this.runtime.agentId}`),
      worldId: stringToUuid(`rolodex-world-${this.runtime.agentId}`),
      sourceEntityId: this.runtime.agentId,
      data: contactInfoToMetadata(contactInfo),
      createdAt: Date.now(),
    });

    this.setCacheWithLimit(
      this.contactInfoCache,
      entityId,
      contactInfo,
      RolodexService.CONTACT_CACHE_LIMIT,
    );

    // Emit entity lifecycle event
    const entity = await this.runtime.getEntityById(entityId);
    if (entity) {
      await (
        this.runtime as {
          emitEvent: (
            event: string,
            payload: Record<string, JsonValue | object>,
          ) => Promise<void>;
        }
      ).emitEvent(EntityLifecycleEvent.UPDATED, {
        entityId: entity.id ?? "",
        source: "rolodex",
      });
    }

    logger.info(
      `[RolodexService] Added contact ${entityId} with categories: ${categories.join(", ")}`,
    );
    return contactInfo;
  }

  async updateContact(
    entityId: UUID,
    updates: Partial<ContactInfo>,
  ): Promise<ContactInfo | null> {
    const existing = await this.getContact(entityId);
    if (!existing) {
      logger.warn(`[RolodexService] Contact ${entityId} not found`);
      return null;
    }

    const updated: ContactInfo = {
      ...existing,
      ...updates,
      entityId, // Ensure entityId cannot be changed
      lastModified: new Date().toISOString(),
    };

    // Update component
    const components = await this.runtime.getComponents(entityId);
    const contactComponent = components.find(
      (c) => c.type === "contact_info" && c.agentId === this.runtime.agentId,
    );

    if (contactComponent) {
      await this.runtime.updateComponent({
        ...contactComponent,
        data: contactInfoToMetadata(updated),
      });
    }

    this.setCacheWithLimit(
      this.contactInfoCache,
      entityId,
      updated,
      RolodexService.CONTACT_CACHE_LIMIT,
    );

    logger.info(`[RolodexService] Updated contact ${entityId}`);
    return updated;
  }

  async getContact(entityId: UUID): Promise<ContactInfo | null> {
    // Check cache first
    if (this.contactInfoCache.has(entityId)) {
      const cached = this.contactInfoCache.get(entityId);
      if (cached) {
        return cached;
      }
    }

    // Load from component if not in cache
    const components = await this.runtime.getComponents(entityId);
    const contactComponent = components.find(
      (c) => c.type === "contact_info" && c.agentId === this.runtime.agentId,
    );

    if (contactComponent?.data) {
      const contactInfo = metadataToContactInfo(
        contactComponent.data as Metadata,
      );
      this.setCacheWithLimit(
        this.contactInfoCache,
        entityId,
        contactInfo,
        RolodexService.CONTACT_CACHE_LIMIT,
      );
      return contactInfo;
    }

    return null;
  }

  async removeContact(entityId: UUID): Promise<boolean> {
    const existing = await this.getContact(entityId);
    if (!existing) {
      logger.warn(`[RolodexService] Contact ${entityId} not found`);
      return false;
    }

    // Remove component
    const components = await this.runtime.getComponents(entityId);
    const contactComponent = components.find(
      (c) => c.type === "contact_info" && c.agentId === this.runtime.agentId,
    );

    if (contactComponent) {
      await this.runtime.deleteComponent(contactComponent.id);
    }

    // Remove from cache
    this.contactInfoCache.delete(entityId);

    logger.info(`[RolodexService] Removed contact ${entityId}`);
    return true;
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

      // Check categories
      if (criteria.categories && criteria.categories.length > 0) {
        const categorySet = new Set(contactInfo.categories);
        matches =
          matches && criteria.categories.some((cat) => categorySet.has(cat));
      }

      // Check tags
      if (criteria.tags && criteria.tags.length > 0) {
        const tagSet = new Set(contactInfo.tags);
        matches = matches && criteria.tags.some((tag) => tagSet.has(tag));
      }

      // Check privacy level
      if (criteria.privacyLevel) {
        matches = matches && contactInfo.privacyLevel === criteria.privacyLevel;
      }

      if (matches) {
        results.push(contactInfo);
      }
    }

    // If searchTerm is provided, further filter by entity names
    if (criteria.searchTerm) {
      const searchTermLower = criteria.searchTerm.toLowerCase();
      const entities = await Promise.all(
        results.map((contact) => this.runtime.getEntityById(contact.entityId)),
      );
      const filteredResults: ContactInfo[] = [];
      for (let i = 0; i < results.length; i++) {
        const entity = entities[i];
        if (
          entity?.names.some((name) =>
            name.toLowerCase().includes(searchTermLower),
          )
        ) {
          filteredResults.push(results[i]);
        }
      }
      return filteredResults;
    }

    return results;
  }

  // Relationship Analytics Methods
  async analyzeRelationship(
    sourceEntityId: UUID,
    targetEntityId: UUID,
  ): Promise<RelationshipAnalytics | null> {
    const cacheKey = `${sourceEntityId}-${targetEntityId}`;

    // Check cache first
    if (this.analyticsCache.has(cacheKey)) {
      const cached = this.analyticsCache.get(cacheKey);
      if (cached) {
        // Cache for 1 hour
        if (
          cached.lastInteractionAt &&
          Date.now() - new Date(cached.lastInteractionAt).getTime() < 3600000
        ) {
          return cached;
        }
      }
    }

    // Get relationship
    const relationships = await this.runtime.getRelationships({
      entityId: sourceEntityId,
    });

    const relationship = relationships.find(
      (r) =>
        r.targetEntityId === targetEntityId ||
        r.sourceEntityId === targetEntityId,
    ) as ExtendedRelationship | undefined;

    if (!relationship) {
      return null;
    }

    // Get recent messages between entities
    const messages = await this.runtime.getMemories({
      tableName: "messages",
      entityId: sourceEntityId,
      count: 100,
    });

    const interactions = messages.filter(
      (m) =>
        m.content.inReplyTo === targetEntityId ||
        (m.entityId === targetEntityId &&
          m.content.inReplyTo === sourceEntityId),
    );

    // Calculate metrics
    const interactionCount = interactions.length;
    const lastInteraction = interactions[0];
    const lastInteractionAt = lastInteraction?.createdAt
      ? new Date(lastInteraction.createdAt).toISOString()
      : undefined;

    // Calculate average response time
    let totalResponseTime = 0;
    let responseCount = 0;

    for (let i = 0; i < interactions.length - 1; i++) {
      const current = interactions[i];
      const next = interactions[i + 1];

      if (
        current.entityId !== next.entityId &&
        current.createdAt &&
        next.createdAt
      ) {
        const timeDiff =
          new Date(next.createdAt).getTime() -
          new Date(current.createdAt).getTime();
        totalResponseTime += timeDiff;
        responseCount++;
      }
    }

    const averageResponseTime =
      responseCount > 0 ? totalResponseTime / responseCount : undefined;

    // Extract topics (simplified - could use NLP)
    const topicsSet = new Set<string>();
    for (const msg of interactions) {
      const text = msg.content.text || "";
      // Simple keyword extraction - could be enhanced with NLP
      const keywords = text.match(/\b[A-Z][a-z]+\b/g) || [];
      for (const k of keywords) {
        topicsSet.add(k);
      }
    }

    // Calculate relationship strength
    const strength = calculateRelationshipStrength({
      interactionCount,
      lastInteractionAt,
      relationshipType: relationship.relationshipType,
    });

    const analytics: RelationshipAnalytics = {
      strength,
      interactionCount,
      lastInteractionAt,
      averageResponseTime,
      sentimentScore: 0.7, // Placeholder - could integrate sentiment analysis
      topicsDiscussed: Array.from(topicsSet).slice(0, 10),
    };

    // Update relationship with calculated strength
    if (
      relationship.strength !== strength ||
      relationship.lastInteractionAt !== lastInteractionAt
    ) {
      // Update relationship using components
      const relationshipComponent = {
        id: stringToUuid(`relationship-${relationship.id}`),
        type: "relationship_update",
        agentId: this.runtime.agentId,
        entityId: relationship.sourceEntityId,
        roomId: stringToUuid(`rolodex-${this.runtime.agentId}`),
        worldId: stringToUuid(`rolodex-world-${this.runtime.agentId}`),
        sourceEntityId: relationship.sourceEntityId,
        data: {
          targetEntityId: relationship.targetEntityId,
          strength,
          lastInteractionAt,
          metadata: relationship.metadata,
        } as Metadata,
        createdAt: Date.now(),
      };
      await this.runtime.createComponent(relationshipComponent);
    }

    // Cache the result
    this.setCacheWithLimit(
      this.analyticsCache,
      cacheKey,
      analytics,
      RolodexService.ANALYTICS_CACHE_LIMIT,
    );

    return analytics;
  }

  async getRelationshipInsights(entityId: UUID): Promise<{
    strongestRelationships: Array<{
      entity: Entity;
      analytics: RelationshipAnalytics;
    }>;
    needsAttention: Array<{ entity: Entity; daysSinceContact: number }>;
    recentInteractions: Array<{ entity: Entity; lastInteraction: string }>;
  }> {
    const relationships = await this.runtime.getRelationships({ entityId });
    const insights = {
      strongestRelationships: [] as Array<{
        entity: Entity;
        analytics: RelationshipAnalytics;
      }>,
      needsAttention: [] as Array<{
        entity: Entity;
        daysSinceContact: number;
      }>,
      recentInteractions: [] as Array<{
        entity: Entity;
        lastInteraction: string;
      }>,
    };

    const targets = relationships.map((rel) =>
      rel.sourceEntityId === entityId ? rel.targetEntityId : rel.sourceEntityId,
    );
    const entities = await Promise.all(
      targets.map((target) => this.runtime.getEntityById(target)),
    );
    const analyticsResults = await Promise.all(
      targets.map((target, index) =>
        entities[index] ? this.analyzeRelationship(entityId, target) : null,
      ),
    );

    for (let i = 0; i < relationships.length; i++) {
      const entity = entities[i];
      const analytics = analyticsResults[i];
      if (!entity || !analytics) continue;

      // Strongest relationships
      if (analytics.strength > 70) {
        insights.strongestRelationships.push({ entity, analytics });
      }

      // Needs attention (no contact in 30+ days)
      if (analytics.lastInteractionAt) {
        const daysSince =
          (Date.now() - new Date(analytics.lastInteractionAt).getTime()) /
          (1000 * 60 * 60 * 24);

        if (daysSince > 30) {
          insights.needsAttention.push({
            entity,
            daysSinceContact: Math.round(daysSince),
          });
        }

        // Recent interactions (last 7 days)
        if (daysSince < 7) {
          insights.recentInteractions.push({
            entity,
            lastInteraction: analytics.lastInteractionAt,
          });
        }
      }
    }

    // Sort by relevance
    insights.strongestRelationships.sort(
      (a, b) => b.analytics.strength - a.analytics.strength,
    );
    insights.needsAttention.sort(
      (a, b) => b.daysSinceContact - a.daysSinceContact,
    );
    insights.recentInteractions.sort(
      (a, b) =>
        new Date(b.lastInteraction).getTime() -
        new Date(a.lastInteraction).getTime(),
    );

    return insights;
  }

  // Category Management
  async getCategories(): Promise<ContactCategory[]> {
    return this.categoriesCache;
  }

  async addCategory(category: ContactCategory): Promise<void> {
    if (this.categoriesCache.find((c) => c.id === category.id)) {
      throw new Error(`Category ${category.id} already exists`);
    }

    this.categoriesCache.push(category);
    logger.info(`[RolodexService] Added category: ${category.name}`);
  }

  // Privacy Management
  async setContactPrivacy(
    entityId: UUID,
    privacyLevel: "public" | "private" | "restricted",
  ): Promise<boolean> {
    const contact = await this.getContact(entityId);
    if (!contact) return false;

    contact.privacyLevel = privacyLevel;
    await this.updateContact(entityId, { privacyLevel });

    logger.info(
      `[RolodexService] Set privacy level for ${entityId} to ${privacyLevel}`,
    );
    return true;
  }

  async canAccessContact(
    requestingEntityId: UUID,
    targetEntityId: UUID,
  ): Promise<boolean> {
    const contact = await this.getContact(targetEntityId);
    if (!contact) return false;

    // Agent always has access
    if (requestingEntityId === this.runtime.agentId) return true;

    // Check privacy level
    switch (contact.privacyLevel) {
      case "public":
        return true;
      case "private":
        // Only agent and the entity itself
        return requestingEntityId === targetEntityId;
      case "restricted":
        // Only agent
        return false;
      default:
        return false;
    }
  }
}
