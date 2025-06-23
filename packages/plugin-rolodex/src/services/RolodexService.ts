import {
  logger,
  Service,
  stringToUuid,
  ChannelType,
} from '@elizaos/core';
import type {
  Entity,
  IAgentRuntime,
  Metadata,
  Relationship,
  UUID,
} from '@elizaos/core';
import { RelationshipType, type EntityRelationship } from '../types';

// Import managers (not services)
import { EntityResolutionManager } from '../managers/EntityResolutionManager';
import { RelationshipOntologyManager } from '../managers/RelationshipOntologyManager';
import { AutonomousRelationshipManager } from '../managers/AutonomousRelationshipManager';
import { EventBridge } from '../managers/EventBridge';
import { FollowUpManager } from '../managers/FollowUpManager';
import { EntityGraphManager } from '../managers/EntityGraphManager';

// Import our local calculateRelationshipStrength function since it's not exported from core yet
import { calculateRelationshipStrength } from '../utils/relationshipStrength';

// Trust integration imports - using any until proper types are available
// These services are dynamically loaded from the trust plugin

// Trust-related interfaces
interface TrustContext {
  entityId: UUID;
  action: string;
  timestamp: number;
  environment: string;
  metadata?: Record<string, any>;
}

interface TrustDecision {
  decision: 'allow' | 'deny' | 'review';
  confidence: number;
  reasons: string[];
  riskScore: number;
  recommendations?: string[];
}

interface TrustScore {
  score: number;
  confidence: number;
  factors: Record<string, number>;
  history: Array<{
    score: number;
    timestamp: number;
  }>;
}

/**
 * The RolodexService provides unified contact and relationship management functionality.
 * It manages various sub-managers for different aspects of entity and relationship management.
 */
export class RolodexService extends Service {
  static serviceType = 'rolodex' as const;
  override serviceName = 'rolodex';

  // Managers
  public entityResolutionManager?: EntityResolutionManager;
  public relationshipOntologyManager?: RelationshipOntologyManager;
  public autonomousRelationshipManager?: AutonomousRelationshipManager;
  public eventBridge?: EventBridge;
  public followUpManager?: FollowUpManager;
  public entityGraphManager?: EntityGraphManager;

  // Trust service integration
  private trustService?: any;
  private trustManagerService?: any;
  
  private databaseReady = false;

  constructor() {
    super();
  }

  // Static factory method required by ElizaOS
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new RolodexService();
    // @ts-ignore - runtime is set by base class
    service.runtime = runtime;
    await service.initialize();
    return service;
  }

  /**
   * Initializes the RolodexService and all its managers
   */
  async initialize(): Promise<void> {
    logger.info('[RolodexService] Initializing...');

    if (!this.runtime) {
      throw new Error('[RolodexService] Runtime is required for initialization');
    }

    try {
      // Check database adapter
      if (!this.runtime.db) {
        logger.error('[RolodexService] Database adapter not available');
        throw new Error('Database adapter required');
      }

      // Initialize EventBridge first as other managers may use it
      this.eventBridge = new EventBridge(this.runtime);
      await this.eventBridge.initialize();

      // Initialize managers
      this.entityResolutionManager = new EntityResolutionManager(this.runtime, this.eventBridge);
      await this.entityResolutionManager.initialize();

      this.relationshipOntologyManager = new RelationshipOntologyManager(this.runtime, this.eventBridge);
      await this.relationshipOntologyManager.initialize();

      this.followUpManager = new FollowUpManager(this.runtime, this.eventBridge);
      await this.followUpManager.initialize();

      this.entityGraphManager = new EntityGraphManager(this.runtime, this.eventBridge);
      await this.entityGraphManager.initialize();

      // Initialize autonomous manager last as it depends on others
      this.autonomousRelationshipManager = new AutonomousRelationshipManager(
        this.runtime
      );
      await this.autonomousRelationshipManager.initialize();

      // Try to get trust services (may not be available)
      this.trustService = this.runtime.getService('trust');
      this.trustManagerService = this.runtime.getService('trustManager');

      if (this.trustService) {
        logger.info('[RolodexService] Trust service integration enabled');
      } else {
        logger.info('[RolodexService] Trust service not available - operating without trust scoring');
      }

      // Setup database tables
      await this.ensureDatabaseTables();
      this.databaseReady = true;

      // Start autonomous operations if enabled
      if (this.autonomousRelationshipManager) {
        await this.autonomousRelationshipManager.start();
      }

      logger.info('[RolodexService] Successfully initialized');
    } catch (error) {
      logger.error('[RolodexService] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Ensures that required database tables exist
   */
  private async ensureDatabaseTables(): Promise<void> {
    logger.info('[RolodexService] Ensuring database tables exist');

    try {
      // The database adapter should have already created these tables
      // Just verify they exist
      const tablesExist = await this.verifyTables();
      if (!tablesExist) {
        throw new Error('Required database tables are missing');
      }
    } catch (error) {
      logger.error('[RolodexService] Failed to verify database tables:', error);
      throw error;
    }
  }

  /**
   * Verifies that required tables exist
   */
  private async verifyTables(): Promise<boolean> {
    try {
      // Test queries to verify tables exist
      await this.runtime.db.query('SELECT 1 FROM entities LIMIT 1');
      await this.runtime.db.query('SELECT 1 FROM relationships LIMIT 1');
      return true;
    } catch (error) {
      logger.error('[RolodexService] Table verification failed:', error);
      return false;
    }
  }

  /**
   * Ensures the database is ready before performing operations
   */
  private ensureReady(): void {
    if (!this.databaseReady) {
      throw new Error('[RolodexService] Service not ready - database not initialized');
    }
  }

  // === Entity Management (delegated to managers) ===

  /**
   * Creates or updates an entity using advanced resolution
   */
  async upsertEntity(entity: Partial<Entity>): Promise<Entity> {
    this.ensureReady();
    
    if (!this.entityResolutionManager) {
      throw new Error('Entity resolution manager not initialized');
    }

    // Use entity resolution for intelligent entity management
    const entityId = entity.id || stringToUuid(entity.names?.[0] || `entity-${Date.now()}`);
    
    // Check for existing entities that might be the same
    const candidates = await this.entityResolutionManager.resolveEntity(
      entity.names?.[0] || '',
      {
        roomId: this.runtime.agentId
      }
    );

    if (candidates.length > 0 && candidates[0].confidence > 0.8) {
      // Update existing entity
      const existingId = candidates[0].entityId;
      return await this.entityGraphManager!.updateEntity(existingId, entity);
    } else {
      // Create new entity
      return await this.entityGraphManager!.createEntity({
        ...entity,
        id: entityId as UUID,
        agentId: entity.agentId || this.runtime.agentId,
        names: entity.names || ['Unknown'],
      });
    }
  }

  /**
   * Gets an entity by ID
   */
  async getEntity(entityId: UUID): Promise<Entity | null> {
    this.ensureReady();
    return this.entityGraphManager?.getEntity(entityId) || null;
  }

  /**
   * Searches for entities with advanced matching
   */
  async searchEntities(query: string, limit = 10): Promise<Entity[]> {
    this.ensureReady();
    
    if (!this.entityGraphManager) {
      return [];
    }

    const results = await this.entityGraphManager.searchEntities(query, {
      limit
    });

    // Convert EntitySearchResult to Entity format
    return results.map(result => ({
      id: result.entity.entityId as UUID,
      agentId: result.entity.agentId as UUID,
      names: result.entity.names,
      metadata: result.entity.metadata || {}
    }));
  }

  // === Relationship Management (delegated to managers) ===

  /**
   * Analyzes an interaction and updates relationships using the ontology system
   */
  async analyzeInteraction(
    sourceId: UUID,
    targetId: UUID,
    interaction: string,
    context?: {
      roomId?: UUID;
      messageId?: UUID;
    }
  ): Promise<Relationship> {
    this.ensureReady();
    
    if (!this.relationshipOntologyManager) {
      throw new Error('Relationship ontology manager not initialized');
    }

    // Use the advanced multi-dimensional relationship analysis
    const matrix = await this.relationshipOntologyManager.analyzeInteraction(
      sourceId,
      targetId,
      interaction,
      context
    );

    // Convert matrix to simple relationship for backward compatibility
    return this.relationshipOntologyManager.matrixToRelationship(matrix);
  }

  /**
   * Gets relationships for an entity
   */
  async getRelationships(entityId: UUID): Promise<Relationship[]> {
    this.ensureReady();
    
    if (!this.entityGraphManager) {
      return [];
    }

    return await this.entityGraphManager.getEntityRelationships(entityId);
  }

  // === Trust Management ===

  /**
   * Gets trust score for an entity
   */
  async getTrustScore(entityId: UUID): Promise<TrustScore | null> {
    if (!this.trustService) {
      logger.debug('[RolodexService] Trust service not available');
      return null;
    }

    try {
      const score = await this.trustService.getTrustScore(entityId);
      return score;
    } catch (error) {
      logger.error('[RolodexService] Failed to get trust score:', error);
      return null;
    }
  }

  /**
   * Updates trust score based on interaction
   */
  async updateTrustFromInteraction(
    entityId: UUID,
    interaction: {
      type: string;
      outcome: 'positive' | 'negative' | 'neutral';
      metadata?: Record<string, any>;
    }
  ): Promise<void> {
    if (!this.trustService) {
      logger.debug('[RolodexService] Trust service not available');
      return;
    }

    try {
      await this.trustService.recordInteraction(entityId, interaction);
    } catch (error) {
      logger.error('[RolodexService] Failed to update trust from interaction:', error);
    }
  }

  // === Follow-up Management ===

  /**
   * Schedules a follow-up for an entity
   */
  async scheduleFollowUp(
    entityId: UUID,
    followUp: {
      message: string;
      scheduledFor: Date;
      priority?: 'low' | 'medium' | 'high';
      metadata?: Record<string, any>;
    }
  ): Promise<any> {
    this.ensureReady();
    
    if (!this.followUpManager) {
      throw new Error('Follow-up manager not initialized');
    }

    return await this.followUpManager.scheduleFollowUp(
      entityId, 
      followUp.message, 
      followUp.scheduledFor,
      followUp
    );
  }

  /**
   * Gets upcoming follow-ups
   */
  async getUpcomingFollowUps(options?: {
    entityId?: UUID;
    limit?: number;
    includePast?: boolean;
  }): Promise<any[]> {
    this.ensureReady();
    
    if (!this.followUpManager) {
      return [];
    }

    return await this.followUpManager.getFollowUps(options?.entityId);
  }

  // === Advanced Features ===

  /**
   * Gets a full entity profile including relationships and trust
   */
  async getEntityProfile(entityId: UUID): Promise<any> {
    this.ensureReady();

    try {
      const entity = await this.getEntity(entityId);
      if (!entity) {
        return null;
      }

      const relationships = await this.getRelationships(entityId);
      const trustScore = await this.getTrustScore(entityId);
      const upcomingFollowUps = await this.getUpcomingFollowUps({ entityId });

      return {
        entity,
        relationships,
        trustScore,
        followUps: upcomingFollowUps,
        metadata: {
          relationshipCount: relationships.length,
          hasTrustData: !!trustScore,
          pendingFollowUps: upcomingFollowUps.length
        },
      };
    } catch (error) {
      logger.error('[RolodexService] Failed to get entity profile:', error);
      throw error;
    }
  }

  /**
   * Merges two entities
   */
  async mergeEntities(primaryId: UUID, secondaryId: UUID): Promise<Entity> {
    this.ensureReady();
    
    if (!this.entityResolutionManager) {
      throw new Error('Entity resolution manager not initialized');
    }

    return await this.entityResolutionManager.mergeEntities(primaryId, [secondaryId]);
  }

  /**
   * Gets network statistics
   */
  async getNetworkStats(): Promise<any> {
    this.ensureReady();
    
    if (!this.entityGraphManager) {
      return {
        totalEntities: 0,
        totalRelationships: 0,
        avgRelationshipsPerEntity: 0,
        strongRelationships: 0,
      };
    }

    return await this.entityGraphManager.getNetworkStats();
  }

  /**
   * Gets autonomous system status
   */
  async getAutonomousSystemStatus(): Promise<any> {
    if (!this.autonomousRelationshipManager) {
      return { enabled: false };
    }

    return await this.autonomousRelationshipManager.getSystemStatus();
  }

  /**
   * Gets event bridge for external event handling
   */
  getEventBridge(): EventBridge | undefined {
    return this.eventBridge;
  }

  /**
   * Stops the service and all managers
   */
  async stop(): Promise<void> {
    logger.info('[RolodexService] Stopping...');
    
    // Stop managers in reverse order
    if (this.autonomousRelationshipManager) {
      await this.autonomousRelationshipManager.stop();
    }
    
    if (this.entityGraphManager) {
      await this.entityGraphManager.stop();
    }
    
    if (this.followUpManager) {
      await this.followUpManager.stop();
    }
    
    if (this.relationshipOntologyManager) {
      await this.relationshipOntologyManager.stop();
    }
    
    if (this.entityResolutionManager) {
      await this.entityResolutionManager.stop();
    }
    
    if (this.eventBridge) {
      await this.eventBridge.stop();
    }
    
    this.databaseReady = false;
    logger.info('[RolodexService] Stopped');
  }

  /**
   * Gets service description for runtime
   */
  get capabilityDescription(): string {
    return 'Unified entity and relationship management with trust integration, autonomous operations, and advanced analytics';
  }

  // === Legacy compatibility methods ===

  /**
   * Legacy method for backward compatibility
   */
  async getAllRelationships(): Promise<any[]> {
    this.ensureReady();
    
    if (!this.entityGraphManager) {
      return [];
    }

    return await this.entityGraphManager.getAllRelationships();
  }

  /**
   * Exports all contacts
   */
  async exportContacts(): Promise<Entity[]> {
    this.ensureReady();

    try {
      return await this.runtime.db.query(
        'SELECT * FROM entities WHERE agentId = ?',
        [this.runtime.agentId]
      );
    } catch (error) {
      logger.error('[RolodexService] Failed to export contacts:', error);
      return [];
    }
  }
}
