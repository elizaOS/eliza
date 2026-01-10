import { logger, type IAgentRuntime, type UUID } from '@elizaos/core';
import type { TrackedEntity, WorldState, DetectedObject, PersonInfo, BoundingBox } from './types';

export class EntityTracker {
  private worldState: WorldState;
  private readonly POSITION_THRESHOLD = 100; // pixels
  private readonly MISSING_THRESHOLD = 5000; // 5 seconds
  private readonly CLEANUP_THRESHOLD = 60000; // 1 minute

  constructor(worldId: string) {
    this.worldState = {
      worldId,
      entities: new Map(),
      lastUpdate: Date.now(),
      activeEntities: [],
      recentlyLeft: [],
    };
  }

  async updateEntities(
    detectedObjects: DetectedObject[],
    people: PersonInfo[],
    faceProfiles?: Map<string, string>, // Maps person ID to face profile ID
    runtime?: IAgentRuntime
  ): Promise<TrackedEntity[]> {
    const currentTime = Date.now();
    const frameEntities: TrackedEntity[] = [];
    const seenEntityIds = new Set<string>();

    // Process detected people
    for (const person of people) {
      const entity = await this.trackPerson(person, faceProfiles?.get(person.id), currentTime);
      frameEntities.push(entity);
      seenEntityIds.add(entity.id);
    }

    // Process detected objects
    for (const obj of detectedObjects) {
      if (obj.type !== 'person' && obj.type !== 'person-candidate') {
        const entity = await this.trackObject(obj, currentTime);
        frameEntities.push(entity);
        seenEntityIds.add(entity.id);
      }
    }

    // Update world state
    this.updateWorldState(seenEntityIds, currentTime);

    // Store entities in runtime if available
    if (runtime) {
      await this.syncWithRuntime(runtime, frameEntities);
    }

    return frameEntities;
  }

  private async trackPerson(
    person: PersonInfo,
    faceProfileId: string | undefined,
    timestamp: number
  ): Promise<TrackedEntity> {
    // Try to match with existing entities
    const matchedEntity = this.findMatchingEntity(person.boundingBox, 'person', faceProfileId);

    if (matchedEntity) {
      // Update existing entity
      matchedEntity.lastSeen = timestamp;
      matchedEntity.lastPosition = person.boundingBox;
      matchedEntity.appearances.push({
        timestamp,
        boundingBox: person.boundingBox,
        confidence: person.confidence,
      });

      // Update attributes
      if (faceProfileId && !matchedEntity.attributes.faceId) {
        matchedEntity.attributes.faceId = faceProfileId;
      }

      // Keep only last 100 appearances
      if (matchedEntity.appearances.length > 100) {
        matchedEntity.appearances = matchedEntity.appearances.slice(-100);
      }

      return matchedEntity;
    } else {
      // Create new entity
      const entityId = `person-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;
      const newEntity: TrackedEntity = {
        id: entityId,
        entityType: 'person',
        firstSeen: timestamp,
        lastSeen: timestamp,
        lastPosition: person.boundingBox,
        appearances: [
          {
            timestamp,
            boundingBox: person.boundingBox,
            confidence: person.confidence,
          },
        ],
        attributes: {
          faceId: faceProfileId,
        },
        worldId: this.worldState.worldId,
      };

      this.worldState.entities.set(entityId, newEntity);
      logger.info(`[EntityTracker] New person entity created: ${entityId}`);

      return newEntity;
    }
  }

  private async trackObject(obj: DetectedObject, timestamp: number): Promise<TrackedEntity> {
    // Try to match with existing entities
    const matchedEntity = this.findMatchingEntity(obj.boundingBox, 'object');

    if (matchedEntity) {
      // Update existing entity
      matchedEntity.lastSeen = timestamp;
      matchedEntity.lastPosition = obj.boundingBox;
      matchedEntity.appearances.push({
        timestamp,
        boundingBox: obj.boundingBox,
        confidence: obj.confidence,
      });

      // Keep only last 50 appearances for objects
      if (matchedEntity.appearances.length > 50) {
        matchedEntity.appearances = matchedEntity.appearances.slice(-50);
      }

      return matchedEntity;
    } else {
      // Create new entity
      const entityId = `object-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;
      const newEntity: TrackedEntity = {
        id: entityId,
        entityType: 'object',
        firstSeen: timestamp,
        lastSeen: timestamp,
        lastPosition: obj.boundingBox,
        appearances: [
          {
            timestamp,
            boundingBox: obj.boundingBox,
            confidence: obj.confidence,
          },
        ],
        attributes: {
          objectType: obj.type,
        },
        worldId: this.worldState.worldId,
      };

      this.worldState.entities.set(entityId, newEntity);
      logger.debug(`[EntityTracker] New object entity created: ${entityId} (${obj.type})`);

      return newEntity;
    }
  }

  private findMatchingEntity(
    boundingBox: BoundingBox,
    entityType: 'person' | 'object',
    faceProfileId?: string
  ): TrackedEntity | null {
    const currentTime = Date.now();
    let bestMatch: TrackedEntity | null = null;
    let minDistance = Infinity;

    for (const entity of this.worldState.entities.values()) {
      // Skip if wrong type
      if (entity.entityType !== entityType) {
        continue;
      }

      // Skip if entity has been missing too long
      if (currentTime - entity.lastSeen > this.MISSING_THRESHOLD) {
        continue;
      }

      // If we have face ID, prioritize face matching for people
      if (entityType === 'person' && faceProfileId && entity.attributes.faceId) {
        if (entity.attributes.faceId === faceProfileId) {
          return entity; // Direct face match
        }
      }

      // Calculate position distance
      const distance = this.calculateDistance(entity.lastPosition, boundingBox);

      if (distance < this.POSITION_THRESHOLD && distance < minDistance) {
        minDistance = distance;
        bestMatch = entity;
      }
    }

    return bestMatch;
  }

  private calculateDistance(box1: BoundingBox, box2: BoundingBox): number {
    const center1 = {
      x: box1.x + box1.width / 2,
      y: box1.y + box1.height / 2,
    };
    const center2 = {
      x: box2.x + box2.width / 2,
      y: box2.y + box2.height / 2,
    };

    return Math.sqrt(Math.pow(center1.x - center2.x, 2) + Math.pow(center1.y - center2.y, 2));
  }

  private updateWorldState(seenEntityIds: Set<string>, timestamp: number): void {
    // Update active entities
    this.worldState.activeEntities = Array.from(seenEntityIds);
    this.worldState.lastUpdate = timestamp;

    // Check for entities that left
    for (const [entityId, entity] of this.worldState.entities) {
      if (!seenEntityIds.has(entityId) && this.worldState.activeEntities.includes(entityId)) {
        // Entity just left the scene
        this.worldState.recentlyLeft.push({
          entityId,
          leftAt: timestamp,
          lastPosition: entity.lastPosition,
        });

        logger.info(`[EntityTracker] Entity left scene: ${entityId}`);
      }
    }

    // Clean up old "recently left" entries
    this.worldState.recentlyLeft = this.worldState.recentlyLeft.filter(
      (entry) => timestamp - entry.leftAt < this.CLEANUP_THRESHOLD
    );

    // Clean up very old entities
    for (const [entityId, entity] of this.worldState.entities) {
      if (timestamp - entity.lastSeen > this.CLEANUP_THRESHOLD * 10) {
        this.worldState.entities.delete(entityId);
        logger.debug(`[EntityTracker] Cleaned up old entity: ${entityId}`);
      }
    }
  }

  private async syncWithRuntime(
    runtime: IAgentRuntime,
    frameEntities: TrackedEntity[]
  ): Promise<void> {
    try {
      // Create or update entities in the runtime
      for (const entity of frameEntities) {
        const _elizaEntity = {
          id: entity.id as UUID,
          names: [entity.attributes.name || entity.id],
          metadata: {
            type: entity.entityType,
            firstSeen: entity.firstSeen,
            lastSeen: entity.lastSeen,
            attributes: entity.attributes,
            worldId: this.worldState.worldId,
          },
          agentId: runtime.agentId,
        };

        // For now, we'll just log the entity creation
        // In a real implementation, this would integrate with runtime.createEntity
        logger.debug(`[EntityTracker] Would sync entity ${entity.id} with runtime`);

        // TODO: When runtime supports entity management:
        // const existing = await runtime.getEntity(entity.id as UUID);
        // if (!existing) {
        //   await runtime.createEntity(elizaEntity);
        // } else {
        //   await runtime.updateEntity({...});
        // }
      }
    } catch (error) {
      logger.error('[EntityTracker] Failed to sync with runtime:', error);
    }
  }

  // Public API
  getWorldState(): WorldState {
    return this.worldState;
  }

  getActiveEntities(): TrackedEntity[] {
    return this.worldState.activeEntities
      .map((id) => this.worldState.entities.get(id))
      .filter(Boolean) as TrackedEntity[];
  }

  getEntity(entityId: string): TrackedEntity | undefined {
    return this.worldState.entities.get(entityId);
  }

  getRecentlyLeft(): Array<{ entity: TrackedEntity; leftAt: number }> {
    return this.worldState.recentlyLeft
      .map((entry) => ({
        entity: this.worldState.entities.get(entry.entityId),
        leftAt: entry.leftAt,
      }))
      .filter((entry) => entry.entity) as Array<{ entity: TrackedEntity; leftAt: number }>;
  }

  // Name assignment
  assignNameToEntity(entityId: string, name: string): boolean {
    const entity = this.worldState.entities.get(entityId);
    if (entity) {
      entity.attributes.name = name;
      logger.info(`[EntityTracker] Assigned name "${name}" to entity ${entityId}`);
      return true;
    }
    return false;
  }

  // Get statistics
  getStatistics(): {
    totalEntities: number;
    activeEntities: number;
    recentlyLeft: number;
    people: number;
    objects: number;
  } {
    const entities = Array.from(this.worldState.entities.values());
    return {
      totalEntities: entities.length,
      activeEntities: this.worldState.activeEntities.length,
      recentlyLeft: this.worldState.recentlyLeft.length,
      people: entities.filter((e) => e.entityType === 'person').length,
      objects: entities.filter((e) => e.entityType === 'object').length,
    };
  }
}
