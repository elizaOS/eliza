import { Plugin, Service, type IAgentRuntime, type UUID, type ServiceTypeName, logger } from '@elizaos/core';
import { TrustEngine } from './services/TrustEngine';
import { SecurityModule } from './services/SecurityModule';
import { ContextualPermissionSystem } from './services/ContextualPermissionSystem';
import { CredentialProtector } from './services/CredentialProtector';
import { LLMEvaluator } from './services/LLMEvaluator';
import { updateRoleAction } from './actions/roles';
import { updateSettingsAction } from './actions/settings';
import { recordTrustInteractionAction } from './actions/recordTrustInteraction';
import { evaluateTrustAction } from './actions/evaluateTrust';
import { requestElevationAction } from './actions/requestElevation';
import { roleProvider } from './providers/roles';
import { settingsProvider } from './providers/settings';
import { trustProfileProvider } from './providers/trustProfile';
import { securityStatusProvider } from './providers/securityStatus';
import { reflectionEvaluator } from './evaluators/reflection';
import { trustChangeEvaluator } from './evaluators/trustChangeEvaluator';
import * as schema from './schema';
import { tests as e2eTests } from './tests';
import type { TrustProfile, TrustContext, TrustInteraction, TrustRequirements, TrustDecision } from './types/trust';
import type { SecurityContext, SecurityCheck, ThreatAssessment, SecurityEventType, SecurityEvent } from './types/security';
import type { AccessRequest, AccessDecision, Permission, PermissionContext } from './types/permissions';

// Export types (avoid duplicate exports)
export * from './types/trust';
export type {
  Permission,
  PermissionContext,
  AccessRequest,
  AccessDecision,
  ElevationRequest,
  ElevationResult,
  PermissionDecision,
} from './types/permissions';

// Export services
export { TrustEngine, SecurityModule, ContextualPermissionSystem, CredentialProtector, LLMEvaluator };

// Export types
export * from './types/security';

// Re-export service type for convenience
export type TrustEngineService = InstanceType<typeof TrustEngine>;
export type SecurityModuleService = InstanceType<typeof SecurityModule>;
export type ContextualPermissionSystemService = InstanceType<typeof ContextualPermissionSystem>;
export type CredentialProtectorService = InstanceType<typeof CredentialProtector>;
export type LLMEvaluatorService = InstanceType<typeof LLMEvaluator>;

// Export actions and providers
export * from './actions/index';
export * from './providers/index';
export * from './evaluators/index';

// Service Wrappers
export class TrustEngineServiceWrapper extends Service {
  public static override readonly serviceType = 'trust-engine';
  public readonly capabilityDescription =
    'Multi-dimensional trust scoring and evidence-based trust evaluation';
  public trustEngine!: TrustEngine;

  public static override async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new TrustEngineServiceWrapper(runtime);
    instance.trustEngine = new TrustEngine();
    await instance.trustEngine.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> { }

  // Proxy methods
  calculateTrust(entityId: UUID, context: TrustContext): Promise<TrustProfile> {
    return this.trustEngine.calculateTrust(entityId, context);
  }

  getRecentInteractions(entityId: UUID, limit?: number): Promise<TrustInteraction[]> {
    return this.trustEngine.getRecentInteractions(entityId, limit);
  }

  evaluateTrustDecision(
    entityId: UUID,
    requirements: TrustRequirements,
    context: TrustContext
  ): Promise<TrustDecision> {
    return this.trustEngine.evaluateTrustDecision(entityId, requirements, context);
  }
}

export class SecurityModuleServiceWrapper extends Service {
  public static override readonly serviceType = 'security-module';
  public readonly capabilityDescription =
    'Security threat detection and trust-based security analysis';
  public securityModule!: SecurityModule;

  public static override async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new SecurityModuleServiceWrapper(runtime);

    // Use the proper service promise system to wait for the trust-engine service
    const trustEngineService = await runtime.getServiceLoadPromise('trust-engine' as ServiceTypeName) as TrustEngineServiceWrapper;

    instance.securityModule = new SecurityModule();
    await instance.securityModule.initialize(runtime, trustEngineService.trustEngine);
    return instance;
  }

  async stop(): Promise<void> { }

  // Proxy methods
  detectPromptInjection(content: string, context: SecurityContext): Promise<SecurityCheck> {
    return this.securityModule.detectPromptInjection(content, context);
  }

  assessThreatLevel(context: SecurityContext): Promise<ThreatAssessment> {
    return this.securityModule.assessThreatLevel(context);
  }

  logTrustImpact(
    entityId: UUID,
    event: SecurityEventType,
    impact: number,
    context?: Partial<TrustContext>
  ): Promise<void> {
    return this.securityModule.logTrustImpact(entityId, event, impact, context);
  }

  // Add missing methods for tests
  storeMessage(message: any): Promise<void> {
    return this.securityModule.storeMessage(message);
  }

  storeAction(action: any): Promise<void> {
    return this.securityModule.storeAction(action);
  }

  detectMultiAccountPattern(entities: UUID[], timeWindow?: number): Promise<any> {
    return this.securityModule.detectMultiAccountPattern(entities, timeWindow);
  }

  detectImpersonation(username: string, existingUsers: string[]): Promise<any> {
    return this.securityModule.detectImpersonation(username, existingUsers);
  }

  detectPhishing(messages: any[], entityId: UUID): Promise<any> {
    return this.securityModule.detectPhishing(messages, entityId);
  }

  getRecentSecurityIncidents(roomId?: UUID, hours = 24): Promise<SecurityEvent[]> {
    return this.securityModule.getRecentSecurityIncidents(roomId, hours);
  }

  analyzeMessage(
    message: string,
    entityId: UUID,
    context: SecurityContext
  ): Promise<SecurityCheck> {
    return this.securityModule.analyzeMessage(message, entityId, context);
  }

  getSecurityRecommendations(threatLevel: number): string[] {
    return this.securityModule.getSecurityRecommendations(threatLevel);
  }
}

export class CredentialProtectorServiceWrapper extends Service {
  public static override readonly serviceType = 'credential-protector';
  public readonly capabilityDescription =
    'Detects and prevents credential theft attempts, protects sensitive data';
  public credentialProtector!: CredentialProtector;

  public static override async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new CredentialProtectorServiceWrapper(runtime);

    // Use the proper service promise system to wait for the security-module service
    const securityModuleService = await runtime.getServiceLoadPromise('security-module' as ServiceTypeName) as SecurityModuleServiceWrapper;

    instance.credentialProtector = new CredentialProtector();
    await instance.credentialProtector.initialize(runtime, securityModuleService.securityModule);
    return instance;
  }

  async stop(): Promise<void> { }

  // Proxy methods
  scanForCredentialTheft(message: string, entityId: UUID, context: SecurityContext) {
    return this.credentialProtector.scanForCredentialTheft(message, entityId, context);
  }

  protectSensitiveData(content: string): Promise<string> {
    return this.credentialProtector.protectSensitiveData(content);
  }

  alertPotentialVictims(threatActor: UUID, victims: UUID[], threatDetails: any): Promise<void> {
    return this.credentialProtector.alertPotentialVictims(threatActor, victims, threatDetails);
  }
}

export class ContextualPermissionSystemServiceWrapper extends Service {
  public static override readonly serviceType = 'contextual-permissions';
  public readonly capabilityDescription =
    'Context-aware permission management with trust-based access control';
  public permissionSystem!: ContextualPermissionSystem;

  public static override async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new ContextualPermissionSystemServiceWrapper(runtime);

    // Use the proper service promise system to wait for both required services
    const [trustEngineService, securityModuleService] = await Promise.all([
      runtime.getServiceLoadPromise('trust-engine' as ServiceTypeName) as Promise<TrustEngineServiceWrapper>,
      runtime.getServiceLoadPromise('security-module' as ServiceTypeName) as Promise<SecurityModuleServiceWrapper>
    ]);

    instance.permissionSystem = new ContextualPermissionSystem();
    await instance.permissionSystem.initialize(
      runtime,
      trustEngineService.trustEngine,
      securityModuleService.securityModule
    );
    return instance;
  }

  async stop(): Promise<void> { }

  // Proxy methods
  checkAccess(request: AccessRequest): Promise<AccessDecision> {
    return this.permissionSystem.checkAccess(request);
  }

  hasPermission(
    entityId: UUID,
    permission: Permission,
    context: PermissionContext
  ): Promise<boolean> {
    return this.permissionSystem.hasPermission(entityId, permission, context);
  }
}

export class LLMEvaluatorServiceWrapper extends Service {
  public static override readonly serviceType = 'llm-evaluator';
  public readonly capabilityDescription =
    'LLM-based evaluation for trust and security decisions';
  public llmEvaluator!: LLMEvaluator;

  public static override async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new LLMEvaluatorServiceWrapper(runtime);
    instance.llmEvaluator = new LLMEvaluator();
    await instance.llmEvaluator.initialize(runtime);
    return instance;
  }

  async stop(): Promise<void> {
    await this.llmEvaluator.stop();
  }

  // Proxy methods
  evaluateSecurityThreat(
    message: string,
    context: SecurityContext,
    history?: string[]
  ): Promise<SecurityCheck> {
    return this.llmEvaluator.evaluateSecurityThreat(message, context, history);
  }

  evaluateTrustAction(
    action: string,
    actor: UUID,
    context: TrustContext,
    trustScore: number
  ): Promise<{
    allowed: boolean;
    confidence: number;
    reasoning: string;
    suggestions?: string[];
  }> {
    return this.llmEvaluator.evaluateTrustAction(action, actor, context, trustScore);
  }

  analyzeBehavior(
    messages: string[],
    actions: any[],
    entityId: UUID
  ): Promise<{
    patterns: string[];
    anomalies: string[];
    riskScore: number;
    personality: string;
  }> {
    return this.llmEvaluator.analyzeBehavior(messages, actions, entityId);
  }
}

const trustPlugin: Plugin = {
  name: 'trust',
  description: 'Advanced trust and security system for AI agents',

  actions: [
    updateRoleAction,
    updateSettingsAction,
    recordTrustInteractionAction,
    evaluateTrustAction,
    requestElevationAction,
  ],

  providers: [roleProvider, settingsProvider, trustProfileProvider, securityStatusProvider],

  evaluators: [reflectionEvaluator, trustChangeEvaluator],

  services: [
    TrustEngineServiceWrapper,
    SecurityModuleServiceWrapper,
    CredentialProtectorServiceWrapper,
    ContextualPermissionSystemServiceWrapper,
    LLMEvaluatorServiceWrapper,
  ],

  schema,

  async init(config: Record<string, string>, runtime: IAgentRuntime) {
    logger.info(
      '[TrustPlugin] Initializing trust plugin. Services will be started by the runtime.'
    );
  },

  tests: [
    {
      name: 'Trust System E2E Tests',
      tests: e2eTests,
    },
  ],
};

export default trustPlugin;
