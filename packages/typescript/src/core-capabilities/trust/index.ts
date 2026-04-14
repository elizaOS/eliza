import { logger } from "../../logger.ts";
import {
	type IAgentRuntime,
	type Plugin,
	Role,
	Service,
	type ServiceTypeName,
	type UUID,
} from "../../types/index.ts";
import { evaluateTrustAction } from "./actions/evaluateTrust.ts";
import { recordTrustInteractionAction } from "./actions/recordTrustInteraction.ts";
import { requestElevationAction } from "./actions/requestElevation.ts";
import { updateRoleAction } from "./actions/roles.ts";
import { updateSettingsAction } from "./actions/settings.ts";
import { reflectionEvaluator } from "./evaluators/reflection.ts";
import { securityEvaluator } from "./evaluators/securityEvaluator.ts";
import { trustChangeEvaluator } from "./evaluators/trustChangeEvaluator.ts";
import { adminTrustProvider } from "./providers/adminTrust.ts";
import { roleProvider } from "./providers/roles.ts";
import { securityStatusProvider } from "./providers/securityStatus.ts";
import { settingsProvider } from "./providers/settings.ts";
import { trustProfileProvider } from "./providers/trustProfile.ts";
import * as schema from "./schema.ts";
import { ContextualPermissionSystem } from "./services/ContextualPermissionSystem.ts";
import {
	CredentialProtector,
	type CredentialThreatDetection,
} from "./services/CredentialProtector.ts";
import { SecurityModule } from "./services/SecurityModule.ts";
import { TrustEngine } from "./services/TrustEngine.ts";
import type {
	AccessDecision,
	AccessRequest,
	Permission,
	PermissionContext,
} from "./types/permissions.ts";
import type {
	ImpersonationDetection,
	MultiAccountDetection,
	PhishingDetection,
	Action as SecurityAction,
	SecurityCheck,
	SecurityContext,
	SecurityEvent,
	SecurityEventType,
	Message as SecurityMessage,
	ThreatAssessment,
} from "./types/security.ts";
import type {
	TrustContext,
	TrustDecision,
	TrustInteraction,
	TrustProfile,
	TrustRequirements,
} from "./types/trust.ts";

export type {
	AccessDecision,
	AccessRequest,
	ElevationRequest,
	ElevationResult,
	Permission,
	PermissionContext,
	PermissionDecision,
} from "./types/permissions.ts";
// Export types
export * from "./types/security.ts";
// Export types (avoid duplicate exports)
export * from "./types/trust.ts";
// Export services
export {
	ContextualPermissionSystem,
	CredentialProtector,
	SecurityModule,
	TrustEngine,
};

// Re-export service type for convenience
export type TrustEngineService = InstanceType<typeof TrustEngine>;
export type SecurityModuleService = InstanceType<typeof SecurityModule>;
export type ContextualPermissionSystemService = InstanceType<
	typeof ContextualPermissionSystem
>;
export type CredentialProtectorService = InstanceType<
	typeof CredentialProtector
>;

// Export actions and providers
export * from "./actions/index.ts";
export * from "./evaluators/index.ts";
export * from "./providers/index.ts";

// Service Wrappers
export class TrustEngineServiceWrapper extends Service {
	public static override readonly serviceType = "trust-engine";
	public readonly capabilityDescription =
		"Multi-dimensional trust scoring and evidence-based trust evaluation";
	public trustEngine!: TrustEngine;

	public static override async start(runtime: IAgentRuntime): Promise<Service> {
		const instance = new TrustEngineServiceWrapper(runtime);
		instance.trustEngine = new TrustEngine();
		await instance.trustEngine.initialize(runtime);
		return instance;
	}

	async stop(): Promise<void> {}

	// Proxy methods
	calculateTrust(entityId: UUID, context: TrustContext): Promise<TrustProfile> {
		return this.trustEngine.calculateTrust(entityId, context);
	}

	getRecentInteractions(
		entityId: UUID,
		limit?: number,
	): Promise<TrustInteraction[]> {
		return this.trustEngine.getRecentInteractions(entityId, limit);
	}

	evaluateTrustDecision(
		entityId: UUID,
		requirements: TrustRequirements,
		context: TrustContext,
	): Promise<TrustDecision> {
		return this.trustEngine.evaluateTrustDecision(
			entityId,
			requirements,
			context,
		);
	}
}

export class SecurityModuleServiceWrapper extends Service {
	public static override readonly serviceType = "security-module";
	public readonly capabilityDescription =
		"Security threat detection and trust-based security analysis";
	public securityModule!: SecurityModule;

	public static override async start(runtime: IAgentRuntime): Promise<Service> {
		const instance = new SecurityModuleServiceWrapper(runtime);

		// Use the proper service promise system to wait for the trust-engine service
		const trustEngineService = (await runtime.getServiceLoadPromise(
			"trust-engine" as ServiceTypeName,
		)) as TrustEngineServiceWrapper;

		instance.securityModule = new SecurityModule();
		await instance.securityModule.initialize(
			runtime,
			trustEngineService.trustEngine,
		);
		return instance;
	}

	async stop(): Promise<void> {}

	// Proxy methods
	detectPromptInjection(
		content: string,
		context: SecurityContext,
	): Promise<SecurityCheck> {
		return this.securityModule.detectPromptInjection(content, context);
	}

	assessThreatLevel(context: SecurityContext): Promise<ThreatAssessment> {
		return this.securityModule.assessThreatLevel(context);
	}

	logTrustImpact(
		entityId: UUID,
		event: SecurityEventType,
		impact: number,
		context?: Partial<TrustContext>,
	): Promise<void> {
		return this.securityModule.logTrustImpact(entityId, event, impact, context);
	}

	// Add missing methods for tests
	storeMessage(message: SecurityMessage): Promise<void> {
		return this.securityModule.storeMessage(message);
	}

	storeAction(action: SecurityAction): Promise<void> {
		return this.securityModule.storeAction(action);
	}

	detectMultiAccountPattern(
		entities: UUID[],
		timeWindow?: number,
	): Promise<MultiAccountDetection | null> {
		return this.securityModule.detectMultiAccountPattern(entities, timeWindow);
	}

	detectImpersonation(
		username: string,
		existingUsers: string[],
	): Promise<ImpersonationDetection | null> {
		return this.securityModule.detectImpersonation(username, existingUsers);
	}

	detectPhishing(
		messages: SecurityMessage[],
		entityId: UUID,
	): Promise<PhishingDetection | null> {
		return this.securityModule.detectPhishing(messages, entityId);
	}

	getRecentSecurityIncidents(
		roomId?: UUID,
		hours?: number,
	): Promise<SecurityEvent[]> {
		return this.securityModule.getRecentSecurityIncidents(roomId, hours);
	}

	analyzeMessage(
		message: string,
		entityId: UUID,
		context: SecurityContext,
	): Promise<SecurityCheck> {
		return this.securityModule.analyzeMessage(message, entityId, context);
	}

	getSecurityRecommendations(threatLevel: number): string[] {
		return this.securityModule.getSecurityRecommendations(threatLevel);
	}
}

export class CredentialProtectorServiceWrapper extends Service {
	public static override readonly serviceType = "credential-protector";
	public readonly capabilityDescription =
		"Detects and prevents credential theft attempts, protects sensitive data";
	public credentialProtector!: CredentialProtector;

	public static override async start(runtime: IAgentRuntime): Promise<Service> {
		const instance = new CredentialProtectorServiceWrapper(runtime);

		// Use the proper service promise system to wait for the security-module service
		const securityModuleService = (await runtime.getServiceLoadPromise(
			"security-module" as ServiceTypeName,
		)) as SecurityModuleServiceWrapper;

		instance.credentialProtector = new CredentialProtector();
		await instance.credentialProtector.initialize(
			runtime,
			securityModuleService.securityModule,
		);
		return instance;
	}

	async stop(): Promise<void> {}

	// Proxy methods
	scanForCredentialTheft(
		message: string,
		entityId: UUID,
		context: SecurityContext,
	) {
		return this.credentialProtector.scanForCredentialTheft(
			message,
			entityId,
			context,
		);
	}

	protectSensitiveData(content: string): Promise<string> {
		return this.credentialProtector.protectSensitiveData(content);
	}

	alertPotentialVictims(
		threatActor: UUID,
		victims: UUID[],
		threatDetails: CredentialThreatDetection,
	): Promise<void> {
		return this.credentialProtector.alertPotentialVictims(
			threatActor,
			victims,
			threatDetails,
		);
	}
}

export class ContextualPermissionSystemServiceWrapper extends Service {
	public static override readonly serviceType = "contextual-permissions";
	public readonly capabilityDescription =
		"Context-aware permission management with trust-based access control";
	public permissionSystem!: ContextualPermissionSystem;

	public static override async start(runtime: IAgentRuntime): Promise<Service> {
		const instance = new ContextualPermissionSystemServiceWrapper(runtime);

		// Use the proper service promise system to wait for both required services
		const [trustEngineService, securityModuleService] = await Promise.all([
			runtime.getServiceLoadPromise(
				"trust-engine" as ServiceTypeName,
			) as Promise<TrustEngineServiceWrapper>,
			runtime.getServiceLoadPromise(
				"security-module" as ServiceTypeName,
			) as Promise<SecurityModuleServiceWrapper>,
		]);

		instance.permissionSystem = new ContextualPermissionSystem();
		await instance.permissionSystem.initialize(
			runtime,
			trustEngineService.trustEngine,
			securityModuleService.securityModule,
		);
		return instance;
	}

	async stop(): Promise<void> {}

	// Proxy methods
	checkAccess(request: AccessRequest): Promise<AccessDecision> {
		return this.permissionSystem.checkAccess(request);
	}

	hasPermission(
		entityId: UUID,
		permission: Permission,
		context: PermissionContext,
	): Promise<boolean> {
		return this.permissionSystem.hasPermission(entityId, permission, context);
	}
}

async function ensureAdminRoleOnInit(runtime: IAgentRuntime): Promise<void> {
	const ownerSetting = runtime.getSetting("OWNER_ENTITY_ID");
	const worldSetting = runtime.getSetting("WORLD_ID");
	const adminEntityId =
		typeof ownerSetting === "string" ? ownerSetting : undefined;
	const worldId = typeof worldSetting === "string" ? worldSetting : undefined;

	if (!adminEntityId || !worldId) {
		return;
	}

	try {
		const world = await runtime.getWorld(worldId as UUID);
		if (!world) {
			logger.debug(
				{ worldId, adminEntityId },
				"[TrustPlugin] WORLD_ID not found; skipping admin role bootstrap",
			);
			return;
		}

		const metadata = world.metadata ?? {};
		world.metadata = metadata;

		const metadataRecord = metadata as Record<string, unknown>;
		const roles =
			(metadataRecord.roles as Record<string, Role> | undefined) ?? {};
		metadataRecord.roles = roles;

		const currentRole = roles[adminEntityId];
		if (currentRole === Role.ADMIN || currentRole === Role.OWNER) {
			return;
		}

		roles[adminEntityId] = Role.ADMIN;
		await runtime.updateWorld(world);
		logger.info(
			{ adminEntityId, worldId },
			"[TrustPlugin] Bootstrapped admin role for app user",
		);
	} catch (error) {
		logger.warn(
			{ error, adminEntityId, worldId },
			"[TrustPlugin] Failed to bootstrap admin role on init",
		);
	}
}

const trustPlugin: Plugin = {
	name: "trust",
	description: "Advanced trust and security system for AI agents",

	actions: [
		updateRoleAction,
		updateSettingsAction,
		recordTrustInteractionAction,
		evaluateTrustAction,
		requestElevationAction,
	],

	providers: [
		roleProvider,
		settingsProvider,
		trustProfileProvider,
		securityStatusProvider,
		adminTrustProvider,
	],

	evaluators: [securityEvaluator, reflectionEvaluator, trustChangeEvaluator],

	services: [
		TrustEngineServiceWrapper,
		SecurityModuleServiceWrapper,
		CredentialProtectorServiceWrapper,
		ContextualPermissionSystemServiceWrapper,
	],

	schema,

	async init(_config: Record<string, string>, runtime: IAgentRuntime) {
		await ensureAdminRoleOnInit(runtime);
		logger.info(
			"[TrustPlugin] Initializing trust plugin. Services will be started by the runtime.",
		);
	},
};

export { ensureAdminRoleOnInit, schema };
export default trustPlugin;
