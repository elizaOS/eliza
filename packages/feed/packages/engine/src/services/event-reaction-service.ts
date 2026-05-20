/**
 * Event Reaction Service
 *
 * Orchestrates event awareness for NPCs:
 * 1. Pulls relevant events from Redis cache (fast) or DB (fallback)
 * 2. Filters by affiliation and deduplicates via witnessed_event memory
 * 3. Gathers org coordination context
 * 4. Prioritizes events for NPC attention
 *
 * Uses provider pattern for Redis services (injected from API layer).
 */

import { db, desc, gte, worldEvents } from '@feed/db';
import { logger } from '@feed/shared';
import { npcMemoryService } from './npc-memory-service';
import { StaticDataRegistry } from './static-data-registry';

// =============================================================================
// PROVIDER INTERFACES
// =============================================================================

export interface CachedEvent {
  id: string;
  eventType: string;
  description: string;
  actors: string[];
  affectedOrgIds: string[];
  severity: number;
  timestamp: number;
  pointsToward: 'YES' | 'NO' | null;
}

export interface OrgCoordinationContext {
  orgId: string;
  orgName: string;
  recentReactions: OrgReaction[];
  suggestedAngles: string[];
  avoidAngles: string[];
}

export interface OrgReaction {
  npcId: string;
  npcName: string;
  eventId: string;
  angle: string;
  actionType: 'post' | 'comment' | 'trade';
  sentiment: 'positive' | 'negative' | 'neutral' | 'defensive';
  timestamp: number;
}

export interface EventCacheProvider {
  getHighPriorityEvents(limit: number): Promise<CachedEvent[]>;
  getEventsForOrg(orgId: string, limit: number): Promise<CachedEvent[]>;
  getRecentEvents(lookbackHours: number, limit: number): Promise<CachedEvent[]>;
  deprioritizeEvent(eventId: string): Promise<void>;
}

export interface OrgCoordinationProvider {
  getCoordinationContext(
    orgIds: string[],
    eventId: string,
    orgNames: Map<string, string>
  ): Promise<OrgCoordinationContext[]>;
  hasOrgReactedEnough(
    orgId: string,
    eventId: string,
    threshold: number
  ): Promise<boolean>;
  recordOrgReaction(orgId: string, reaction: OrgReaction): Promise<boolean>;
}

// =============================================================================
// PENDING REACTION TYPE
// =============================================================================

export interface PendingReaction {
  eventId: string;
  eventType: string;
  description: string;
  affectedOrgIds: string[];
  npcRole: 'insider' | 'affiliated' | 'observer';
  severity: number;
  hoursAgo: number;
  pointsToward: 'YES' | 'NO' | null;
  orgCoordination: OrgCoordinationContext[];
  shouldReact: boolean;
  suggestedAction: string;
}

// =============================================================================
// PROVIDER SETTERS
// =============================================================================

let eventCacheProvider: EventCacheProvider | null = null;
let orgCoordinationProvider: OrgCoordinationProvider | null = null;

export function setEventCacheProvider(provider: EventCacheProvider): void {
  eventCacheProvider = provider;
}

export function setOrgCoordinationProvider(
  provider: OrgCoordinationProvider
): void {
  orgCoordinationProvider = provider;
}

// =============================================================================
// SERVICE
// =============================================================================

const SEVERITY_MAP: Record<string, number> = {
  scandal: 5,
  proof: 5,
  confirmation: 4,
  leak: 4,
  revelation: 4,
  rumor: 3,
  denial: 3,
  reversal: 3,
  development: 2,
  meeting: 2,
  deal: 2,
  announcement: 1,
};

export class EventReactionService {
  /**
   * Get events requiring this NPC's attention with full context.
   */
  async getPendingReactions(
    npcId: string,
    options: { lookbackHours?: number; limit?: number } = {}
  ): Promise<PendingReaction[]> {
    const { lookbackHours = 12, limit = 5 } = options;

    // 1. Get NPC info
    const actor = StaticDataRegistry.getActor(npcId);
    if (!actor) {
      logger.debug(
        `Actor not found for pending reactions: ${npcId}`,
        { npcId },
        'EventReactionService'
      );
      return [];
    }

    const affiliatedOrgIds = new Set(actor.affiliations);
    if (affiliatedOrgIds.size === 0) {
      return [];
    }

    // Build org name map for coordination
    const orgNames = new Map<string, string>();
    for (const orgId of affiliatedOrgIds) {
      const org = StaticDataRegistry.getOrganization(orgId);
      if (org) orgNames.set(orgId, org.name);
    }

    // 2. Get events from Redis cache (fast) or fallback to DB
    let events: CachedEvent[];
    if (eventCacheProvider) {
      // Try priority queue first for important events
      const priorityEvents = await eventCacheProvider.getHighPriorityEvents(20);

      // Also get org-specific events
      const orgEvents: CachedEvent[] = [];
      for (const orgId of affiliatedOrgIds) {
        const evts = await eventCacheProvider.getEventsForOrg(orgId, 10);
        orgEvents.push(...evts);
      }

      // Merge and deduplicate
      const seen = new Set<string>();
      events = [];
      for (const evt of [...priorityEvents, ...orgEvents]) {
        if (!seen.has(evt.id)) {
          seen.add(evt.id);
          events.push(evt);
        }
      }
    } else {
      // Fallback to DB query
      events = await this.queryEventsFromDb(lookbackHours);
    }

    if (events.length === 0) return [];

    // 3. Get witnessed events from NPC memory
    const memories = await npcMemoryService.getRecentMemories(npcId, 50, [
      'witnessed_event',
    ]);
    const witnessedEventIds = new Set(
      memories.map((m) => m.eventId).filter((id): id is string => !!id)
    );

    // 4. Filter and enrich events
    const pending: PendingReaction[] = [];

    for (const event of events) {
      if (witnessedEventIds.has(event.id)) continue;

      // Check if NPC is affected
      const eventOrgIds = event.affectedOrgIds;
      const isDirectlyMentioned = event.actors?.includes(npcId) ?? false;
      const isAffiliated = eventOrgIds.some((orgId) =>
        affiliatedOrgIds.has(orgId)
      );

      if (!isDirectlyMentioned && !isAffiliated) continue;

      // Determine role
      const npcRole: PendingReaction['npcRole'] = isDirectlyMentioned
        ? 'insider'
        : 'affiliated';

      // Get org coordination context if available
      let orgCoordination: OrgCoordinationContext[] = [];
      let shouldReact = true;

      if (orgCoordinationProvider) {
        const relevantOrgIds = eventOrgIds.filter((id) =>
          affiliatedOrgIds.has(id)
        );
        orgCoordination = await orgCoordinationProvider.getCoordinationContext(
          relevantOrgIds,
          event.id,
          orgNames
        );

        // Check if org has already reacted enough
        for (const orgId of relevantOrgIds) {
          if (
            await orgCoordinationProvider.hasOrgReactedEnough(
              orgId,
              event.id,
              3
            )
          ) {
            shouldReact = false;
            break;
          }
        }
      }

      const suggestedAction = this.getSuggestedAction(
        npcRole,
        event.eventType,
        event.severity,
        orgCoordination
      );

      pending.push({
        eventId: event.id,
        eventType: event.eventType,
        description: event.description,
        affectedOrgIds: eventOrgIds,
        npcRole,
        severity: event.severity,
        hoursAgo: (Date.now() - event.timestamp) / (60 * 60 * 1000),
        pointsToward: event.pointsToward,
        orgCoordination,
        shouldReact,
        suggestedAction,
      });

      if (pending.length >= limit) break;
    }

    // Sort by priority: insider > affiliated, then severity, then recency
    return pending.sort((a, b) => {
      const rolePriority = { insider: 0, affiliated: 1, observer: 2 };
      const roleDiff = rolePriority[a.npcRole] - rolePriority[b.npcRole];
      if (roleDiff !== 0) return roleDiff;
      const sevDiff = b.severity - a.severity;
      if (sevDiff !== 0) return sevDiff;
      return a.hoursAgo - b.hoursAgo;
    });
  }

  private async queryEventsFromDb(
    lookbackHours: number
  ): Promise<CachedEvent[]> {
    const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(worldEvents)
      .where(gte(worldEvents.timestamp, cutoff))
      .orderBy(desc(worldEvents.timestamp))
      .limit(100);

    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      description: row.description,
      actors: row.actors ?? [],
      affectedOrgIds: this.extractOrgIdsFromActors(row.actors ?? []),
      severity: SEVERITY_MAP[row.eventType] ?? 2,
      timestamp: row.timestamp.getTime(),
      pointsToward: row.pointsToward as 'YES' | 'NO' | null,
    }));
  }

  private extractOrgIdsFromActors(actors: string[]): string[] {
    const orgIds: string[] = [];
    for (const actorId of actors) {
      const org = StaticDataRegistry.getOrganization(actorId);
      if (org) orgIds.push(org.id);
    }
    return orgIds;
  }

  private getSuggestedAction(
    role: 'insider' | 'affiliated' | 'observer',
    eventType: string,
    severity: number,
    coordination: OrgCoordinationContext[]
  ): string {
    // Check if org has enough reactions
    const totalOrgReactions = coordination.reduce(
      (sum, c) => sum + c.recentReactions.length,
      0
    );

    if (totalOrgReactions >= 3) {
      return 'Observe - organization has responded sufficiently';
    }

    if (role === 'insider') {
      if (eventType === 'leak' || eventType === 'scandal') {
        return 'POST - Address the situation directly (damage control)';
      }
      if (eventType === 'rumor') {
        return 'POST - Confirm, deny, or redirect';
      }
      return 'POST or COMMENT - Provide insider perspective';
    }

    if (role === 'affiliated') {
      if (severity >= 4) {
        return 'Consider TRADING based on impact; COMMENT with perspective';
      }
      if (coordination.some((c) => c.suggestedAngles.length > 0)) {
        const suggestion = coordination[0]?.suggestedAngles[0];
        return `COMMENT - ${suggestion}`;
      }
      return 'COMMENT with your unique angle';
    }

    return 'Observe or brief COMMENT';
  }

  /**
   * Record that NPC has witnessed/reacted to an event.
   */
  async recordEventWitnessed(
    npcId: string,
    eventId: string,
    reaction: string,
    sentiment: number = 0
  ): Promise<boolean> {
    return npcMemoryService.addMemory(npcId, {
      type: 'witnessed_event',
      timestamp: new Date().toISOString(),
      summary: reaction,
      eventId,
      sentiment,
    });
  }

  /**
   * Record org reaction (for coordination).
   */
  async recordOrgReaction(
    npcId: string,
    npcName: string,
    eventId: string,
    angle: string,
    actionType: 'post' | 'comment' | 'trade',
    sentiment: 'positive' | 'negative' | 'neutral' | 'defensive'
  ): Promise<void> {
    if (!orgCoordinationProvider) return;

    const actor = StaticDataRegistry.getActor(npcId);
    if (!actor) return;

    for (const orgId of actor.affiliations) {
      await orgCoordinationProvider.recordOrgReaction(orgId, {
        npcId,
        npcName,
        eventId,
        angle,
        actionType,
        sentiment,
        timestamp: Date.now(),
      });
    }
  }
}

export const eventReactionService = new EventReactionService();
