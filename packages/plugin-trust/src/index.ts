import type { IAgentRuntime, Plugin, UUID } from '@elizaos/core';
import { Service, logger } from '@elizaos/core';
import { evaluateTrustAction } from './actions/evaluateTrust';
import { recordTrustInteractionAction } from './actions/recordTrustInteraction';
import { requestElevationAction } from './actions/requestElevation';
import { updateRoleAction } from './actions/roles';
import { TrustDatabase } from './database/TrustDatabase';
import { reflectionEvaluator } from './evaluators/reflection';
import { trustChangeEvaluator } from './evaluators/trustChangeEvaluator';
import { CoreTrustProvider } from './providers/CoreTrustProvider';
import { roleProvider } from './providers/roles';
import { securityStatusProvider } from './providers/securityStatus';
import { trustProfileProvider } from './providers/trustProfile';
import * as schema from './schema';
import { TrustService } from './services/TrustService';
import { tests as e2eTests } from './tests';
import type { TrustRequirements } from './types/trust';
import { SecurityModule } from './services/SecurityModule';
import { PermissionManager } from './managers/PermissionManager';

// Export types
export type {
  AccessDecision,
  AccessRequest,
  ElevationRequest,
  ElevationResult,
  Permission,
  PermissionContext,
  PermissionDecision,
} from './types/permissions';
export * from './types/security';
export * from './types/trust';

// Export services
export { TrustService };

// Export middleware
export {
  TrustMiddleware,
  getHighRiskActions,
  getTrustRequirement,
  requiresElevatedTrust,
  updateTrustRequirement,
} from './middleware';

// Export evaluators
export * from './evaluators/index';

// Export integrations for other plugins
export * from './integrations/index';

// Service wrapper for the database
export class TrustDatabaseServiceWrapper extends Service {
  static serviceName = 'trust-database';
  public capabilityDescription = 'Trust database management';
  private trustDatabase: TrustDatabase;

  constructor(runtime: IAgentRuntime) {
    super();
    this.trustDatabase = new TrustDatabase();
  }

  static async start(runtime: IAgentRuntime): Promise<TrustDatabaseServiceWrapper> {
    const service = new TrustDatabaseServiceWrapper(runtime);
    try {
      await service.trustDatabase.initialize(runtime);
    } catch (error) {
      // If initialization fails, log but don't throw - tables might already exist
      logger.warn('Trust database initialization warning:', error);
    }
    return service;
  }

  async stop(): Promise<void> {
    await this.trustDatabase.stop();
  }
}

// Service wrapper for trust engine
export class TrustServiceWrapper extends Service {
  static serviceName = 'trust';
  public capabilityDescription = 'Comprehensive trust and security management';
  private trustService: TrustService | null = null;

  static async start(runtime: IAgentRuntime): Promise<TrustServiceWrapper> {
    const wrapper = new TrustServiceWrapper();
    const service = await TrustService.start(runtime);
    wrapper.trustService = service as TrustService;
    return wrapper;
  }

  async stop(): Promise<void> {
    if (this.trustService) {
      await this.trustService.stop();
    }
  }

  // Delegate all public methods to the wrapped service
  getTrustScore(entityId: UUID, evaluatorId?: UUID) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.getTrustScore(entityId as UUID, evaluatorId as UUID);
  }

  updateTrust(entityId: UUID, type: any, impact: number, metadata?: Record<string, any>) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.updateTrust(entityId as UUID, type, impact, metadata);
  }

  checkPermission(entityId: UUID, action: string, resource: string, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.checkPermission(
      entityId as UUID,
      action as UUID,
      resource as UUID,
      context
    );
  }

  detectThreats(content: string, entityId: UUID, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.detectThreats(content as UUID, entityId as UUID, context);
  }

  assessThreatLevel(entityId: UUID, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.assessThreatLevel(entityId as UUID, context);
  }

  getTrustHistory(entityId: UUID, days?: number) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.getTrustHistory(entityId as UUID, days);
  }

  evaluateTrustRequirements(entityId: UUID, requirements: TrustRequirements, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.evaluateTrustRequirements(entityId as UUID, requirements, context);
  }

  recordMemory(message: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.recordMemory(message);
  }

  recordAction(entityId: UUID, action: string, result: 'success' | 'failure', metadata?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.recordAction(entityId as UUID, action as UUID, result, metadata);
  }

  getTrustRecommendations(entityId: UUID) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.getTrustRecommendations(entityId as UUID);
  }

  meetsTrustThreshold(entityId: UUID, threshold: number) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.meetsTrustThreshold(entityId as UUID, threshold);
  }

  updateTrustSemantic(entityId: UUID, interaction: string, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.updateTrustSemantic(entityId as UUID, interaction as UUID, context);
  }

  detectThreatsLLM(content: string, entityId: UUID, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.detectThreatsLLM(content as UUID, entityId as UUID, context);
  }

  recordEvidence(entityId: UUID, description: string, context?: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.recordEvidence(entityId as UUID, description as UUID, context);
  }

  // Expose trustEngine for tests that need direct access
  get trustEngine() {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return (this.trustService as any).trustEngine;
  }

  // Add calculateTrust method for tests
  async calculateTrust(entityId: UUID, context: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustEngine.calculateTrust(entityId, context);
  }
}

// Service wrapper for security module
export class SecurityModuleServiceWrapper extends Service {
  static serviceName = 'security-module';
  public capabilityDescription = 'Security threat detection and analysis';
  private securityModule: SecurityModule | null = null;
  private trustEngine: any = null;

  static async start(runtime: IAgentRuntime): Promise<SecurityModuleServiceWrapper> {
    const wrapper = new SecurityModuleServiceWrapper();
    const trustService = runtime.getService<TrustServiceWrapper>('trust');
    if (!trustService) {
      throw new Error('Trust service must be initialized before security module');
    }

    wrapper.securityModule = new SecurityModule();
    wrapper.trustEngine = (trustService as any).trustEngine;
    await wrapper.securityModule.initialize(runtime, wrapper.trustEngine);

    return wrapper;
  }

  async stop(): Promise<void> {
    if (this.securityModule) {
      await this.securityModule.stop();
    }
  }

  // Delegate public methods
  async detectPromptInjection(content: string, context?: any) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.detectPromptInjection(content, context);
  }

  async detectSocialEngineering(content: string, context?: any) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.detectSocialEngineering(content, context);
  }

  async assessThreatLevel(entityId: UUID, context?: any) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    // Convert to SecurityContext format
    const securityContext = {
      entityId,
      ...context,
    };
    return this.securityModule.assessThreatLevel(securityContext);
  }

  async analyzeContent(content: string, entityId: UUID, context?: any) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.analyzeContent(content, entityId, context);
  }

  async detectMultiAccountPattern(entityIds: UUID[]) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.detectMultiAccountPattern(entityIds);
  }

  async detectPhishing(messages: any[], entityId: UUID) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.detectPhishing(messages, entityId);
  }

  async storeMemory(memory: any) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.storeMemory(memory);
  }

  async storeAction(action: any) {
    if (!this.securityModule) {
      throw new Error('Security module not initialized');
    }
    return this.securityModule.storeAction(action);
  }
}

// Service wrapper for permission manager
export class PermissionManagerServiceWrapper extends Service {
  static serviceName = 'contextual-permissions';
  public capabilityDescription = 'Context-aware permission management';
  private permissionManager: PermissionManager | null = null;

  static async start(runtime: IAgentRuntime): Promise<PermissionManagerServiceWrapper> {
    const wrapper = new PermissionManagerServiceWrapper();
    const trustService = runtime.getService<TrustServiceWrapper>('trust');
    if (!trustService) {
      throw new Error('Trust service must be initialized before permission manager');
    }

    const trustEngine = (trustService as any).trustEngine;
    const securityManager = (trustService as any).securityManager;

    wrapper.permissionManager = new PermissionManager();
    await wrapper.permissionManager.initialize(runtime, trustEngine, securityManager);

    return wrapper;
  }

  async stop(): Promise<void> {
    if (this.permissionManager) {
      await this.permissionManager.stop();
    }
  }

  // Delegate public methods
  async checkAccess(request: any) {
    if (!this.permissionManager) {
      throw new Error('Permission manager not initialized');
    }
    return this.permissionManager.checkAccess(request);
  }

  async checkPermission(params: any) {
    if (!this.permissionManager) {
      throw new Error('Permission manager not initialized');
    }
    return this.permissionManager.checkAccess(params);
  }

  async hasRole(entityId: UUID, role: any) {
    if (!this.permissionManager) {
      throw new Error('Permission manager not initialized');
    }
    // Simple role check implementation
    // Note: In a real implementation, this would check against the actual role system
    // For now, we'll return false to indicate the method exists but roles aren't implemented
    return false;
  }
}

// Service wrapper for trust engine with additional alias
export class TrustEngineServiceWrapper extends Service {
  static serviceName = 'trust-engine';
  public capabilityDescription = 'Trust calculation engine (alias for trust service)';
  private trustService: TrustServiceWrapper | null = null;

  static async start(runtime: IAgentRuntime): Promise<TrustEngineServiceWrapper> {
    const wrapper = new TrustEngineServiceWrapper();
    wrapper.trustService = runtime.getService('trust') as TrustServiceWrapper;
    if (!wrapper.trustService) {
      throw new Error('Trust service not available');
    }
    return wrapper;
  }

  async stop(): Promise<void> {
    // No-op, trust service handles its own lifecycle
  }

  // Delegate all methods to trust service
  get trustEngine() {
    return this.trustService?.trustEngine;
  }

  async calculateTrust(entityId: UUID, context: any) {
    if (!this.trustService) {
      throw new Error('Trust service not initialized');
    }
    return this.trustService.calculateTrust(entityId, context);
  }

  async recordInteraction(interaction: any) {
    if (!this.trustEngine) {
      throw new Error('Trust engine not initialized');
    }
    return this.trustEngine.recordInteraction(interaction);
  }
}

// Plugin definition
const trustPlugin: Plugin = {
  name: 'trust',
  description: 'Comprehensive trust and security system for AI agents',

  config: {
    defaultTrust: 50,
    trustDecayRate: 0.01,
    trustGrowthRate: 0.05,
    minimumInteractions: 5,
    threatDetectionThreshold: 0.7,
    elevationRequestTimeout: 3600000, // 1 hour
  },

  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    logger.info('Initializing trust plugin...');

    // Initialize services in order
    await runtime.registerService(TrustDatabaseServiceWrapper);
    await runtime.registerService(TrustServiceWrapper);
    await runtime.registerService(TrustEngineServiceWrapper); // Register alias
    await runtime.registerService(SecurityModuleServiceWrapper);
    await runtime.registerService(PermissionManagerServiceWrapper);

    // Initialize core trust provider for @elizaos/core integration
    const trustService = runtime.getService<TrustServiceWrapper>('trust');
    if (trustService) {
      const provider = new CoreTrustProvider(runtime);
      await provider.initialize();
    }

    logger.info('Trust plugin initialized successfully');
  },

  services: [
    TrustDatabaseServiceWrapper,
    TrustServiceWrapper,
    TrustEngineServiceWrapper,
    SecurityModuleServiceWrapper,
    PermissionManagerServiceWrapper,
  ],

  actions: [
    // Role modification disabled by default (admin-level operation)
    updateRoleAction,
    // Trust interaction recording enabled for activity tracking
    recordTrustInteractionAction,
    // Trust evaluation enabled for security assessment
    evaluateTrustAction,
    // Elevation requests enabled for privilege escalation workflows
    requestElevationAction,
  ],

  providers: [roleProvider, trustProfileProvider, securityStatusProvider],

  evaluators: [reflectionEvaluator, trustChangeEvaluator],

  tests: [
    {
      name: 'trust-plugin-tests',
      tests: e2eTests,
    },
  ],

  schema,
};

export default trustPlugin;
