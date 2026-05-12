import { promoteSubactionsToActions } from "../../actions/promote-subactions.ts";
import { logger } from "../../logger.ts";
import {
	type Action,
	type IAgentRuntime,
	type Plugin,
	Role,
	type UUID,
} from "../../types/index.ts";
import { trustAction } from "./actions/trust.ts";
import { securityEvaluator } from "./evaluators/securityEvaluator.ts";
import { adminTrustProvider } from "./providers/adminTrust.ts";
import { roleProvider } from "./providers/roles.ts";
import { securityStatusProvider } from "./providers/securityStatus.ts";
import { settingsProvider } from "./providers/settings.ts";
import { trustProfileProvider } from "./providers/trustProfile.ts";
import * as schema from "./schema.ts";
import { ContextualPermissionSystem } from "./services/ContextualPermissionSystem.ts";
import { CredentialProtector } from "./services/CredentialProtector.ts";
import { SecurityModule } from "./services/SecurityModule.ts";
import { TrustEngine } from "./services/TrustEngine.ts";
import {
	ContextualPermissionSystemServiceWrapper,
	CredentialProtectorServiceWrapper,
	SecurityModuleServiceWrapper,
	TrustEngineServiceWrapper,
} from "./services/wrappers.ts";

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

// Service Wrappers (extracted to break circular deps with evaluators/providers)
export {
	ContextualPermissionSystemServiceWrapper,
	CredentialProtectorServiceWrapper,
	SecurityModuleServiceWrapper,
	TrustEngineServiceWrapper,
} from "./services/wrappers.ts";

/**
 * Pre-message trust hook actions (formerly the trust evaluators).
 * `securityEvaluator` runs `ALWAYS_BEFORE` to gate adversarial input.
 */
export const trustHookActions: Action[] = [securityEvaluator];

export interface TrustPluginOptions {
	/** When true, register the security pre-gate as a runtime hook action. */
	enableEvaluators?: boolean;
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
				"[Trust] WORLD_ID not found; skipping admin role bootstrap",
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
			"[Trust] Bootstrapped admin role for app user",
		);
	} catch (error) {
		logger.warn(
			{ error, adminEntityId, worldId },
			"[Trust] Failed to bootstrap admin role on init",
		);
	}
}

export function createTrustPlugin(options: TrustPluginOptions = {}): Plugin {
	return {
		name: "trust",
		description: "Advanced trust and security system for AI agents",

		actions: [
			...promoteSubactionsToActions(trustAction),
			...(options.enableEvaluators ? trustHookActions : []),
		],

		providers: [
			roleProvider,
			settingsProvider,
			trustProfileProvider,
			securityStatusProvider,
			adminTrustProvider,
		],

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
				"[Trust] Initializing trust capability. Services will be started by the runtime.",
			);
		},
	};
}

const trustPlugin: Plugin = createTrustPlugin();

export { ensureAdminRoleOnInit, schema };
export default trustPlugin;
