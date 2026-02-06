/**
 * EntityResolutionService — cross-platform identity resolution.
 *
 * The "ultimate goal" of the rolodex: figuring out that Dave on Discord
 * is the same person as @dave_codes on Twitter.
 *
 * Architecture follows a small-world graph approach:
 *   1. Trigger-based, not scan-based — we resolve when new evidence arrives
 *   2. Local neighborhood first — only compare against entities within
 *      2 hops in the social graph (small-world networks cover the
 *      relevant cluster in 2-3 hops)
 *   3. Multi-signal scoring — name similarity, handle correlation,
 *      shared connections, project affinity, self-identification
 *   4. Merge tasks — when confidence is above threshold, create a task
 *      for verification rather than auto-merging
 *
 * This service is intentionally conservative. It's better to miss a
 * connection than to incorrectly merge two different people.
 */

import {
  logger,
  Service,
  stringToUuid,
  ModelType,
  type Entity,
  type IAgentRuntime,
  type UUID,
} from '@elizaos/core';

import type {
  EntityLink,
  EntityLinkStatus,
  ResolutionCandidate,
  ResolutionSignal,
  ResolutionSignalType,
} from '../types/index';

import { RESOLUTION_THRESHOLDS, SIGNAL_WEIGHTS } from '../types/index';

import {
  nameSimilarity,
  handleCorrelation,
  couldBeSameEntity,
  normalizeHandle,
  jaccardSimilarity,
} from '../utils/similarity';

import {
  buildAdjacencyGraph,
  getNeighborhood,
  sharedConnections,
} from '../utils/graphTraversal';

// ──────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────

export class EntityResolutionService extends Service {
  static serviceType = 'entity_resolution' as const;
  capabilityDescription = 'Cross-platform identity resolution using small-world graph analysis';

  /** In-memory index: normalized name/handle -> entity IDs */
  private nameIndex: Map<string, Set<UUID>> = new Map();

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    await this.rebuildNameIndex();
    logger.info(`[EntityResolution] Initialized with ${this.nameIndex.size} indexed names`);
  }

  async stop(): Promise<void> {
    this.nameIndex.clear();
    logger.info('[EntityResolution] Stopped');
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new EntityResolutionService();
    await service.initialize(runtime);
    return service;
  }

  // ── Public API ─────────────────────────────

  /**
   * Trigger resolution for an entity. Called when:
   *  - A new platform identity is added
   *  - A new entity is created
   *  - Someone mentions a name that matches existing entities
   *
   * Uses small-world graph traversal to limit the search space.
   */
  async resolveEntity(entityId: UUID): Promise<EntityLink[]> {
    const entity = await this.runtime.getEntityById(entityId);
    if (!entity) return [];

    // 1. Build the local neighborhood (2 hops in social graph)
    const allRelationships = await this.runtime.getRelationships({ entityId });
    const graph = buildAdjacencyGraph(allRelationships);
    const neighborhood = getNeighborhood(graph, entityId, 2, 200);

    // 2. Also include entities that share names/handles (via index)
    const nameCandidates = this.findByNameOrHandle(entity);
    for (const candidateId of nameCandidates) {
      if (candidateId !== entityId) neighborhood.add(candidateId);
    }

    if (neighborhood.size === 0) return [];

    // 3. Generate candidates by scoring each neighbor
    const candidates: ResolutionCandidate[] = [];

    for (const candidateId of neighborhood) {
      const candidate = await this.runtime.getEntityById(candidateId);
      if (!candidate) continue;

      const signals = await this.computeSignals(entity, candidate, graph);
      const score = this.scoreCandidate(signals);

      if (score >= RESOLUTION_THRESHOLDS.DISCARD) {
        candidates.push({
          entityA: entityId,
          entityB: candidateId,
          signals,
          score,
        });
      }
    }

    // 4. Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // 5. Create entity links / merge tasks for qualifying candidates
    const links: EntityLink[] = [];

    for (const candidate of candidates) {
      if (candidate.score < RESOLUTION_THRESHOLDS.PROPOSE) continue;

      // Check if link already exists
      const existingLink = await this.getExistingLink(candidate.entityA, candidate.entityB);
      if (existingLink) {
        // Update with new signals
        await this.updateLink(existingLink, candidate.signals, candidate.score);
        links.push(existingLink);
        continue;
      }

      // Create new link
      const link = await this.createLink(candidate);
      links.push(link);
    }

    logger.info(
      `[EntityResolution] Resolved entity ${entityId}: ` +
        `${neighborhood.size} neighbors scanned, ${candidates.length} candidates, ${links.length} links created`
    );

    return links;
  }

  /**
   * Look up an entity by name or handle, using the in-memory index
   * for O(1) lookup instead of scanning all entities.
   */
  findByNameOrHandle(entity: Entity): Set<UUID> {
    const results = new Set<UUID>();

    // Check all names
    for (const name of entity.names) {
      const normalized = normalizeHandle(name);
      const matches = this.nameIndex.get(normalized);
      if (matches) {
        for (const id of matches) results.add(id);
      }
    }

    // Check platform identities
    const identities = entity.metadata?.platformIdentities;
    if (Array.isArray(identities)) {
      for (const pi of identities) {
        const handle = (pi as Record<string, unknown>).handle;
        if (typeof handle === 'string') {
          const normalized = normalizeHandle(handle);
          const matches = this.nameIndex.get(normalized);
          if (matches) {
            for (const id of matches) results.add(id);
          }
        }
      }
    }

    return results;
  }

  /**
   * Register a new entity or new names/handles in the index.
   * Called when entities are created or updated.
   */
  indexEntity(entity: Entity): void {
    const id = entity.id as UUID;

    for (const name of entity.names) {
      const normalized = normalizeHandle(name);
      if (normalized.length < 2) continue;
      if (!this.nameIndex.has(normalized)) this.nameIndex.set(normalized, new Set());
      this.nameIndex.get(normalized)!.add(id);
    }

    const identities = entity.metadata?.platformIdentities;
    if (Array.isArray(identities)) {
      for (const pi of identities) {
        const handle = (pi as Record<string, unknown>).handle;
        if (typeof handle === 'string') {
          const normalized = normalizeHandle(handle);
          if (normalized.length < 2) continue;
          if (!this.nameIndex.has(normalized)) this.nameIndex.set(normalized, new Set());
          this.nameIndex.get(normalized)!.add(id);
        }
      }
    }
  }

  /**
   * Get all existing entity links for an entity.
   */
  async getLinks(entityId: UUID): Promise<EntityLink[]> {
    const components = await this.runtime.getComponents(entityId);
    return components
      .filter((c) => c.type === 'entity_link' && c.agentId === this.runtime.agentId)
      .map((c) => c.data as unknown as EntityLink);
  }

  /**
   * Confirm a proposed link (admin or agent verification).
   */
  async confirmLink(linkId: UUID, confirmedBy: UUID): Promise<void> {
    // Find the link component by searching both entities
    // Links are stored on entityA
    const allComponents = await this.findLinkComponent(linkId);
    if (!allComponents) return;

    const { component } = allComponents;
    const linkData = component.data as unknown as EntityLink;

    linkData.status = 'confirmed';
    linkData.confirmedBy = confirmedBy;
    linkData.updatedAt = Date.now();

    await this.runtime.updateComponent({
      ...component,
      data: linkData as unknown as Record<string, unknown>,
    });

    logger.info(`[EntityResolution] Link ${linkId} confirmed by ${confirmedBy}`);
  }

  /**
   * Reject a proposed link.
   */
  async rejectLink(linkId: UUID, rejectedBy: UUID): Promise<void> {
    const result = await this.findLinkComponent(linkId);
    if (!result) return;

    const { component } = result;
    const linkData = component.data as unknown as EntityLink;

    linkData.status = 'rejected';
    linkData.rejectedBy = rejectedBy;
    linkData.updatedAt = Date.now();

    await this.runtime.updateComponent({
      ...component,
      data: linkData as unknown as Record<string, unknown>,
    });

    logger.info(`[EntityResolution] Link ${linkId} rejected by ${rejectedBy}`);
  }

  // ── Signal Computation ─────────────────────

  private async computeSignals(
    entityA: Entity,
    entityB: Entity,
    graph: ReturnType<typeof buildAdjacencyGraph>
  ): Promise<ResolutionSignal[]> {
    const signals: ResolutionSignal[] = [];
    const now = Date.now();

    // 1. Name similarity
    for (const nameA of entityA.names) {
      for (const nameB of entityB.names) {
        const sim = nameSimilarity(nameA, nameB);
        if (sim > 0.6) {
          signals.push({
            type: 'name_match',
            weight: sim,
            evidence: `"${nameA}" ~ "${nameB}" (similarity: ${sim.toFixed(2)})`,
            timestamp: now,
          });
        }
      }
    }

    // 2. Handle correlation across platforms
    const identitiesA = this.getPlatformIdentities(entityA);
    const identitiesB = this.getPlatformIdentities(entityB);

    for (const idA of identitiesA) {
      for (const idB of identitiesB) {
        // Same platform, same handle = very strong signal
        if (idA.platform === idB.platform && normalizeHandle(idA.handle) === normalizeHandle(idB.handle)) {
          signals.push({
            type: 'handle_correlation',
            weight: 0.95,
            evidence: `Same handle on ${idA.platform}: ${idA.handle}`,
            timestamp: now,
          });
        }
        // Different platforms, similar handle = moderate signal
        else if (idA.platform !== idB.platform) {
          const corr = handleCorrelation(idA.handle, idB.handle);
          if (corr > 0.7) {
            signals.push({
              type: 'handle_correlation',
              weight: corr * 0.8,
              evidence: `${idA.platform}:${idA.handle} ~ ${idB.platform}:${idB.handle} (correlation: ${corr.toFixed(2)})`,
              timestamp: now,
            });
          }
        }
      }
    }

    // 3. Shared connections (Jaccard similarity of 1-hop neighborhoods)
    const aId = entityA.id as UUID;
    const bId = entityB.id as UUID;
    const shared = sharedConnections(graph, aId, bId);
    const neighborsA = graph.get(aId);
    const neighborsB = graph.get(bId);

    if (neighborsA && neighborsB && (neighborsA.size > 0 || neighborsB.size > 0)) {
      const jaccard = jaccardSimilarity(neighborsA, neighborsB);
      if (jaccard > 0.2) {
        signals.push({
          type: 'shared_connections',
          weight: jaccard,
          evidence: `${shared.size} shared connections (Jaccard: ${jaccard.toFixed(2)})`,
          timestamp: now,
        });
      }
    }

    // 4. Self-identification: check if either entity's claims reference the other
    const claimsA = await this.runtime.getComponents(aId);
    const claimsB = await this.runtime.getComponents(bId);

    for (const claim of claimsA) {
      if (claim.type !== 'information_claim') continue;
      // Check if entityA claims a handle that matches entityB's identity
      for (const idB of identitiesB) {
        if (
          claim.data.field === 'platform_identity' &&
          claim.data.platform === idB.platform &&
          normalizeHandle(claim.data.value as string) === normalizeHandle(idB.handle)
        ) {
          signals.push({
            type: 'self_identification',
            weight: (claim.data.confidence as number) ?? 0.7,
            evidence: `Entity A claims ${idB.platform} handle ${idB.handle} matching entity B`,
            timestamp: now,
          });
        }
      }
    }

    // 5. Project affinity: check if both entities are associated with same topics/projects
    const mentionsA = (entityA.metadata?.mentions ?? []) as Array<Record<string, unknown>>;
    const mentionsB = (entityB.metadata?.mentions ?? []) as Array<Record<string, unknown>>;

    if (mentionsA.length > 0 && mentionsB.length > 0) {
      const contextsA = new Set(mentionsA.map((m) => String(m.context ?? '').toLowerCase()));
      const contextsB = new Set(mentionsB.map((m) => String(m.context ?? '').toLowerCase()));

      // Check for shared keywords in contexts
      const keywordsA = extractKeywords(contextsA);
      const keywordsB = extractKeywords(contextsB);
      const sharedKeywords = jaccardSimilarity(keywordsA, keywordsB);

      if (sharedKeywords > 0.15) {
        signals.push({
          type: 'project_affinity',
          weight: sharedKeywords,
          evidence: `Shared topic keywords (overlap: ${sharedKeywords.toFixed(2)})`,
          timestamp: now,
        });
      }
    }

    return signals;
  }

  /**
   * Score a set of signals into a single confidence value.
   *
   * Uses weighted combination with diminishing returns for multiple
   * signals of the same type.
   */
  private scoreCandidate(signals: ResolutionSignal[]): number {
    if (signals.length === 0) return 0;

    // Group signals by type
    const byType = new Map<ResolutionSignalType, ResolutionSignal[]>();
    for (const signal of signals) {
      const group = byType.get(signal.type) ?? [];
      group.push(signal);
      byType.set(signal.type, group);
    }

    let totalScore = 0;

    for (const [type, typeSignals] of byType) {
      const typeWeight = SIGNAL_WEIGHTS[type] ?? 0.1;

      // Take the best signal of each type, with diminishing returns for extras
      const sorted = typeSignals.sort((a, b) => b.weight - a.weight);
      let typeScore = sorted[0].weight * typeWeight;

      // Additional signals of same type add diminishing value
      for (let i = 1; i < sorted.length; i++) {
        typeScore += sorted[i].weight * typeWeight * Math.pow(0.3, i);
      }

      totalScore += typeScore;
    }

    // Clamp to 0-1
    return Math.max(0, Math.min(1, totalScore));
  }

  // ── Link Management ────────────────────────

  private async getExistingLink(entityA: UUID, entityB: UUID): Promise<EntityLink | null> {
    const componentsA = await this.runtime.getComponents(entityA);
    const link = componentsA.find(
      (c) =>
        c.type === 'entity_link' &&
        c.agentId === this.runtime.agentId &&
        ((c.data.entityA === entityA && c.data.entityB === entityB) ||
          (c.data.entityA === entityB && c.data.entityB === entityA))
    );

    return link ? (link.data as unknown as EntityLink) : null;
  }

  private async createLink(candidate: ResolutionCandidate): Promise<EntityLink> {
    const linkId = stringToUuid(
      `link-${candidate.entityA}-${candidate.entityB}-${this.runtime.agentId}`
    );

    const status: EntityLinkStatus =
      candidate.score >= RESOLUTION_THRESHOLDS.AUTO_CONFIRM ? 'confirmed' : 'proposed';

    const link: EntityLink = {
      id: linkId,
      entityA: candidate.entityA,
      entityB: candidate.entityB,
      confidence: candidate.score,
      status,
      signals: candidate.signals,
      proposedBy: 'system',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Store as component on entityA
    await this.runtime.createComponent({
      id: linkId,
      type: 'entity_link',
      agentId: this.runtime.agentId,
      entityId: candidate.entityA,
      roomId: stringToUuid(`rolodex-${this.runtime.agentId}`),
      worldId: stringToUuid(`rolodex-world-${this.runtime.agentId}`),
      sourceEntityId: this.runtime.agentId,
      data: link as unknown as Record<string, unknown>,
      createdAt: Date.now(),
    });

    // Create a merge task for review
    if (status === 'proposed') {
      await this.createMergeTask(link);
    }

    logger.info(
      `[EntityResolution] Created ${status} link between ${candidate.entityA} and ${candidate.entityB} ` +
        `(confidence: ${candidate.score.toFixed(2)}, signals: ${candidate.signals.length})`
    );

    return link;
  }

  private async updateLink(
    existingLink: EntityLink,
    newSignals: ResolutionSignal[],
    newScore: number
  ): Promise<void> {
    // Merge signals (avoid duplicates by type+evidence)
    const existingKeys = new Set(existingLink.signals.map((s) => `${s.type}:${s.evidence}`));
    const merged = [...existingLink.signals];

    for (const signal of newSignals) {
      const key = `${signal.type}:${signal.evidence}`;
      if (!existingKeys.has(key)) {
        merged.push(signal);
      }
    }

    existingLink.signals = merged;
    existingLink.confidence = Math.max(existingLink.confidence, newScore);
    existingLink.updatedAt = Date.now();

    // Check if we should auto-confirm now
    if (
      existingLink.status === 'proposed' &&
      existingLink.confidence >= RESOLUTION_THRESHOLDS.AUTO_CONFIRM
    ) {
      existingLink.status = 'confirmed';
      logger.info(
        `[EntityResolution] Link ${existingLink.id} auto-confirmed (confidence: ${existingLink.confidence.toFixed(2)})`
      );
    }

    // Update the component
    const components = await this.runtime.getComponents(existingLink.entityA);
    const component = components.find(
      (c) => c.type === 'entity_link' && c.id === existingLink.id
    );

    if (component) {
      await this.runtime.updateComponent({
        ...component,
        data: existingLink as unknown as Record<string, unknown>,
      });
    }
  }

  /**
   * Create a merge task that stays open until verified.
   */
  private async createMergeTask(link: EntityLink): Promise<void> {
    const entityA = await this.runtime.getEntityById(link.entityA);
    const entityB = await this.runtime.getEntityById(link.entityB);

    const nameA = entityA?.names[0] ?? 'Unknown';
    const nameB = entityB?.names[0] ?? 'Unknown';

    const signalSummary = link.signals
      .map((s) => `- [${s.type}] ${s.evidence} (weight: ${s.weight.toFixed(2)})`)
      .join('\n');

    try {
      await this.runtime.createTask({
        name: `entity_merge_candidate`,
        description: `Review whether "${nameA}" and "${nameB}" are the same person`,
        tags: ['rolodex', 'entity-merge', 'pending-review'],
        metadata: {
          linkId: link.id,
          entityA: link.entityA,
          entityB: link.entityB,
          nameA,
          nameB,
          confidence: link.confidence,
          signals: signalSummary,
        },
        roomId: stringToUuid(`rolodex-${this.runtime.agentId}`),
      });

      logger.info(
        `[EntityResolution] Created merge task for "${nameA}" <-> "${nameB}" (confidence: ${link.confidence.toFixed(2)})`
      );
    } catch (error) {
      logger.warn(
        '[EntityResolution] Could not create merge task:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async findLinkComponent(linkId: UUID) {
    // We need to search for the component; links are stored on entityA
    // For now, use a search across recent components
    // This is a limitation; in production we'd want an index
    try {
      // Try to find by checking if linkId is used as a component ID
      const rooms = await this.runtime.getRooms(stringToUuid(`rolodex-world-${this.runtime.agentId}`));
      for (const room of rooms) {
        const entities = await this.runtime.getEntitiesForRoom(room.id, true);
        for (const entity of entities) {
          const components = await this.runtime.getComponents(entity.id as UUID);
          const component = components.find(
            (c) => c.type === 'entity_link' && c.id === linkId
          );
          if (component) {
            return { component, entity };
          }
        }
      }
    } catch {
      // Fallback: can't find the link
    }
    return null;
  }

  // ── Helpers ────────────────────────────────

  private getPlatformIdentities(
    entity: Entity
  ): Array<{ platform: string; handle: string }> {
    const identities = entity.metadata?.platformIdentities;
    if (!Array.isArray(identities)) return [];

    return identities
      .map((pi) => {
        const rec = pi as Record<string, unknown>;
        return {
          platform: String(rec.platform ?? ''),
          handle: String(rec.handle ?? ''),
        };
      })
      .filter((pi) => pi.platform && pi.handle);
  }

  private async rebuildNameIndex(): Promise<void> {
    this.nameIndex.clear();

    try {
      const worldId = stringToUuid(`world-${this.runtime.agentId}`);
      const rooms = await this.runtime.getRooms(worldId);

      for (const room of rooms) {
        const entities = await this.runtime.getEntitiesForRoom(room.id, true);
        for (const entity of entities) {
          this.indexEntity(entity);
        }
      }
    } catch (error) {
      logger.warn(
        '[EntityResolution] Could not rebuild name index:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

// ── Module-level helpers ──────────────────────

function extractKeywords(contexts: Set<string>): Set<string> {
  const keywords = new Set<string>();
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'was', 'are', 'were', 'been', 'be',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall', 'and',
    'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'only', 'same',
    'than', 'too', 'very', 'just', 'of', 'in', 'on', 'at',
    'to', 'for', 'with', 'by', 'from', 'about', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she',
    'it', 'they', 'them', 'their', 'this', 'that', 'these', 'those',
  ]);

  for (const context of contexts) {
    const words = context.split(/\s+/);
    for (const word of words) {
      const cleaned = word.replace(/[^a-z0-9]/g, '');
      if (cleaned.length >= 3 && !stopWords.has(cleaned)) {
        keywords.add(cleaned);
      }
    }
  }

  return keywords;
}
