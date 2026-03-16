import {
  type IAgentRuntime,
  type Entity,
  type Relationship,
  type UUID,
  type Component,
  logger,
} from '@elizaos/core';

export interface EntityExpectations {
  names?: string[];
  hasMetadata?: string[];
  platformIdentities?: Array<{
    platform: string;
    handle: string;
    verified?: boolean;
  }>;
  trustMetrics?: {
    minHelpfulness?: number;
    maxSuspicionLevel?: number;
  };
}

export interface RelationshipExpectations {
  exists: boolean;
  type?: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
  minStrength?: number;
  hasIndicators?: boolean;
}

export interface DisputeExpectations {
  exists: boolean;
  disputedField?: string;
  disputer?: string;
  count?: number;
}

export interface PrivacyExpectations {
  hasPrivateData: boolean;
  sharingRestrictions?: string[];
}

export class ScenarioVerifier {
  private runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
  }

  /**
   * Verifies entity creation and metadata
   */
  async verifyEntity(entityId: UUID, expected: EntityExpectations): Promise<void> {
    const entity = await this.runtime.getEntityById(entityId);

    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    // Verify names
    if (expected.names) {
      for (const name of expected.names) {
        if (!entity.names.some((n) => n.toLowerCase() === name.toLowerCase())) {
          throw new Error(`Entity missing expected name: ${name}`);
        }
      }
    }

    // Verify metadata fields exist
    if (expected.hasMetadata) {
      const metadata = entity.metadata || {};
      for (const field of expected.hasMetadata) {
        if (!(field in metadata)) {
          throw new Error(`Entity missing expected metadata field: ${field}`);
        }
      }
    }

    // Verify platform identities
    if (expected.platformIdentities) {
      const platformIdentities = (entity.metadata?.platformIdentities || []) as any[];

      for (const expectedIdentity of expected.platformIdentities) {
        const found = platformIdentities.find(
          (pi) => pi.platform === expectedIdentity.platform && pi.handle === expectedIdentity.handle
        );

        if (!found) {
          throw new Error(
            `Entity missing platform identity: ${expectedIdentity.platform}/${expectedIdentity.handle}`
          );
        }

        if (
          expectedIdentity.verified !== undefined &&
          found.verified !== expectedIdentity.verified
        ) {
          throw new Error(
            `Platform identity verification mismatch for ${expectedIdentity.platform}`
          );
        }
      }
    }

    // Verify trust metrics
    if (expected.trustMetrics) {
      const trustMetrics = entity.metadata?.trustMetrics as any;

      if (!trustMetrics) {
        throw new Error('Entity missing trust metrics');
      }

      if (
        expected.trustMetrics.minHelpfulness !== undefined &&
        trustMetrics.helpfulness < expected.trustMetrics.minHelpfulness
      ) {
        throw new Error(
          `Helpfulness ${trustMetrics.helpfulness} below minimum ${expected.trustMetrics.minHelpfulness}`
        );
      }

      if (
        expected.trustMetrics.maxSuspicionLevel !== undefined &&
        trustMetrics.suspicionLevel > expected.trustMetrics.maxSuspicionLevel
      ) {
        throw new Error(
          `Suspicion level ${trustMetrics.suspicionLevel} above maximum ${expected.trustMetrics.maxSuspicionLevel}`
        );
      }
    }

    logger.info(`[ScenarioVerifier] Entity verified: ${entityId} (${entity.names.join(', ')})`);
  }

  /**
   * Verifies relationship creation and properties
   */
  async verifyRelationship(
    entityA: UUID,
    entityB: UUID,
    expected: RelationshipExpectations
  ): Promise<void> {
    const relationships = await this.runtime.getRelationships({ entityId: entityA });

    const relationship = relationships.find(
      (r) =>
        (r.sourceEntityId === entityA && r.targetEntityId === entityB) ||
        (r.sourceEntityId === entityB && r.targetEntityId === entityA)
    );

    if (expected.exists && !relationship) {
      throw new Error(`Expected relationship between ${entityA} and ${entityB} not found`);
    }

    if (!expected.exists && relationship) {
      throw new Error(`Unexpected relationship found between ${entityA} and ${entityB}`);
    }

    if (!relationship) return;

    // Verify relationship type
    if (expected.type && relationship.metadata?.type !== expected.type) {
      throw new Error(
        `Relationship type mismatch: expected ${expected.type}, got ${relationship.metadata?.type}`
      );
    }

    // Verify sentiment
    if (expected.sentiment && relationship.metadata?.sentiment !== expected.sentiment) {
      throw new Error(
        `Relationship sentiment mismatch: expected ${expected.sentiment}, got ${relationship.metadata?.sentiment}`
      );
    }

    // Verify strength
    if (expected.minStrength !== undefined) {
      const strength = (relationship.metadata?.strength as number) || 0;

      if (strength < expected.minStrength) {
        throw new Error(`Relationship strength ${strength} below minimum ${expected.minStrength}`);
      }
    }

    // Verify indicators exist
    if (expected.hasIndicators && !relationship.metadata?.indicators) {
      throw new Error('Relationship missing expected indicators');
    }

    logger.info(`[ScenarioVerifier] Relationship verified: ${relationship.sourceEntityId} -> ${relationship.targetEntityId} (${relationship.metadata?.type || 'unknown'})`);
  }

  /**
   * Verifies dispute logging
   */
  async verifyDispute(entityId: UUID, expected: DisputeExpectations): Promise<void> {
    // Get dispute components
    const components = await this.runtime.getComponents(entityId);

    const disputes = components.filter((c) => c.type === 'dispute_record');

    if (expected.exists && disputes.length === 0) {
      throw new Error('Expected disputes not found');
    }

    if (!expected.exists && disputes.length > 0) {
      throw new Error('Unexpected disputes found');
    }

    if (expected.count !== undefined && disputes.length !== expected.count) {
      throw new Error(`Dispute count mismatch: expected ${expected.count}, got ${disputes.length}`);
    }

    if (expected.disputedField && disputes.length > 0) {
      const hasField = disputes.some((d) => d.data.disputedField === expected.disputedField);
      if (!hasField) {
        throw new Error(`No dispute found for field: ${expected.disputedField}`);
      }
    }

    if (expected.disputer && disputes.length > 0) {
      const hasDisputer = disputes.some((d) => {
        const disputerName = d.data.disputerName as string || '';
        return disputerName.toLowerCase() === expected.disputer!.toLowerCase();
      });

      if (!hasDisputer) {
        throw new Error(`No dispute found from disputer: ${expected.disputer}`);
      }
    }

    logger.info(`[ScenarioVerifier] Disputes verified: ${entityId} (${disputes.length} disputes)`);
  }

  /**
   * Verifies privacy boundaries
   */
  async verifyPrivacy(entityId: UUID, expected: PrivacyExpectations): Promise<void> {
    const entity = await this.runtime.getEntityById(entityId);

    if (!entity) {
      throw new Error(`Entity ${entityId} not found`);
    }

    const metadata = entity.metadata || {};
    const hasPrivateData = !!metadata.privateData || !!metadata.confidential;

    if (expected.hasPrivateData !== hasPrivateData) {
      throw new Error(
        `Privacy data mismatch: expected ${expected.hasPrivateData}, got ${hasPrivateData}`
      );
    }

    if (expected.sharingRestrictions) {
      const restrictions = (metadata.sharingRestrictions || []) as string[];

      for (const restriction of expected.sharingRestrictions) {
        if (!restrictions.includes(restriction)) {
          throw new Error(`Missing expected sharing restriction: ${restriction}`);
        }
      }
    }

    logger.info(`[ScenarioVerifier] Privacy verified: ${entityId} (hasPrivateData: ${hasPrivateData})`);
  }

  /**
   * Helper method to verify component existence
   */
  async verifyComponent(
    entityId: UUID,
    componentType: string,
    shouldExist: boolean
  ): Promise<void> {
    const components = await this.runtime.getComponents(entityId);

    const exists = components.filter(c => c.type === componentType).length > 0;

    if (shouldExist !== exists) {
      throw new Error(
        `Component ${componentType} ${shouldExist ? 'not found' : 'unexpectedly found'} for entity ${entityId}`
      );
    }

    logger.info(`[ScenarioVerifier] Component verified: ${entityId} (${componentType}: ${exists})`);
  }

  /**
   * Verifies that a mentioned person was created as an entity
   */
  async verifyMentionedPerson(personName: string, mentionedBy: UUID): Promise<void> {
    // Search for the entity by name
    const memories = await this.runtime.getMemories({
      tableName: 'entities',
      count: 1000,
      unique: true,
    });

    let found = false;
    for (const memory of memories) {
      if (memory.entityId) {
        const entity = await this.runtime.getEntityById(memory.entityId);
        if (
          entity &&
          entity.names.some((name) => name.toLowerCase() === personName.toLowerCase())
        ) {
          // Verify it was mentioned by the expected entity
          if (entity.metadata?.mentionedBy === mentionedBy) {
            found = true;
            break;
          }
        }
      }
    }

    if (!found) {
      throw new Error(
        `Mentioned person '${personName}' not found or not mentioned by ${mentionedBy}`
      );
    }

    logger.info(`[ScenarioVerifier] Mentioned person verified: ${personName} (mentioned by ${mentionedBy})`);
  }
}
