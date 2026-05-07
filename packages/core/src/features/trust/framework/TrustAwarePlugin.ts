import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	Action as ElizaAction,
	Evaluator,
	IAgentRuntime,
	Memory,
	Plugin,
	Provider,
	ServiceClass,
	State,
	UUID,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import type { ContextualPermissionSystem } from "../services/ContextualPermissionSystem.ts";
import type { SecurityModule } from "../services/SecurityModule.ts";
import type { TrustEngine } from "../services/TrustEngine.ts";
import {
	type AccessDecision,
	type AccessRequest,
	type ActionPermission,
	PermissionUtils,
} from "../types/permissions.ts";
import { TrustEvidenceType } from "../types/trust.ts";

/**
 * Base class for trust-aware plugins
 * Provides automatic trust checking and permission management
 */
export abstract class TrustAwarePlugin implements Plugin {
	protected trustEngine: TrustEngine | null = null;
	protected permissionSystem: ContextualPermissionSystem | null = null;
	protected securityModule: SecurityModule | null = null;

	/**
	 * Define required trust levels for actions
	 * Override in subclasses
	 */
	protected abstract trustRequirements: Record<string, number>;

	/**
	 * Define required permissions for actions
	 * Override in subclasses
	 */
	protected abstract permissions: Record<string, ActionPermission>;

	/**
	 * Initialize trust-aware services
	 */
	async init(
		_config: Record<string, string>,
		runtime: IAgentRuntime,
	): Promise<void> {
		const trustService = runtime.getService("trust-engine");
		const permService = runtime.getService("contextual-permissions");
		const secService = runtime.getService("security-module");

		if (trustService) {
			this.trustEngine = (
				trustService as unknown as { trustEngine: TrustEngine }
			).trustEngine;
		}
		if (permService) {
			this.permissionSystem = (
				permService as unknown as {
					permissionSystem: ContextualPermissionSystem;
				}
			).permissionSystem;
		}
		if (secService) {
			this.securityModule = (
				secService as unknown as { securityModule: SecurityModule }
			).securityModule;
		}

		if (this.actions) {
			this.actions = this.actions.map((action) => this.wrapAction(action));
		}
	}

	/**
	 * Wrap an action with trust and permission checking
	 */
	protected wrapAction(action: ElizaAction): ElizaAction {
		const originalHandler = action.handler;
		const originalValidate = action.validate;

		return {
			...action,
			validate: async (
				runtime: IAgentRuntime,
				message: Memory,
				state?: State,
			) => {
				if (originalValidate) {
					const valid = await originalValidate(runtime, message, state);
					if (!valid) return false;
				}

				const trustRequired = this.trustRequirements[action.name];
				if (trustRequired && this.trustEngine) {
					const trust = await this.trustEngine.calculateTrust(
						message.entityId,
						{
							evaluatorId: runtime.agentId,
							roomId: message.roomId,
						},
					);

					if (trust.overallTrust < trustRequired) {
						logger.warn(
							`[TrustAware] Insufficient trust for ${action.name}: ${trust.overallTrust} < ${trustRequired}`,
						);
						return false;
					}
				}

				const permission = this.permissions[action.name];
				if (permission && this.permissionSystem) {
					const allowed = await this.checkPermission(
						runtime,
						message,
						permission,
					);
					if (!allowed) {
						logger.warn(`[TrustAware] Permission denied for ${action.name}`);
						return false;
					}
				}

				return true;
			},

			handler: async (
				runtime: IAgentRuntime,
				message: Memory,
				state?: State,
			) => {
				logger.info(
					`[TrustAware] Audit: ${message.entityId} executing ${action.name}`,
				);

				const result = await originalHandler(runtime, message, state);

				if (this.trustEngine && result) {
					await this.trustEngine.recordInteraction({
						sourceEntityId: message.entityId,
						targetEntityId: runtime.agentId,
						type: TrustEvidenceType.HELPFUL_ACTION,
						timestamp: Date.now(),
						impact: 1,
						details: {
							action: action.name,
							success: true,
						},
					});
				}

				return result;
			},
		};
	}

	/**
	 * Check if user has permission to execute action
	 */
	protected async checkPermission(
		runtime: IAgentRuntime,
		message: Memory,
		permission: ActionPermission,
	): Promise<boolean> {
		if (!this.permissionSystem) return true;

		const context = {
			caller: message.entityId,
			action: permission.action,
			trust: 0,
			roles: [] as string[],
		};

		if (this.trustEngine) {
			const trust = await this.trustEngine.calculateTrust(message.entityId, {
				evaluatorId: runtime.agentId,
				roomId: message.roomId,
			});
			context.trust = trust.overallTrust;
		}

		return PermissionUtils.canExecute(permission.unix, context);
	}

	/**
	 * Get trust level for a user
	 */
	protected async getTrustLevel(
		runtime: IAgentRuntime,
		userId: UUID,
	): Promise<number> {
		if (!this.trustEngine) return 0;

		const trust = await this.trustEngine.calculateTrust(userId, {
			evaluatorId: runtime.agentId,
		});

		return trust.overallTrust;
	}

	/**
	 * Check if user is trusted (>= 80 trust score)
	 */
	protected async isTrusted(
		runtime: IAgentRuntime,
		userId: UUID,
	): Promise<boolean> {
		const trust = await this.getTrustLevel(runtime, userId);
		return trust >= 80;
	}

	/**
	 * Check if user is admin
	 */
	protected isAdmin(_userId: UUID): boolean {
		return false;
	}

	/**
	 * Check if user is system/agent
	 */
	protected isSystem(_userId: UUID): boolean {
		return false;
	}

	// Required Plugin properties
	abstract name: string;
	abstract description: string;
	abstract actions?: ElizaAction[];
	abstract providers?: Provider[];
	abstract evaluators?: Evaluator[];
	abstract services?: ServiceClass[];
}

// Example usage
export const exampleTrustAwarePlugin: Plugin = {
	name: "example-trust-aware",
	description: "Example of trust-aware plugin",

	actions: [
		{
			name: "sensitive-action",
			contexts: ["admin", "secrets", "settings"],
			contextGate: { anyOf: ["admin", "secrets", "settings"] },
			description: "A sensitive action requiring trust",
			parameters: [],
			examples: [],
			validate: async (_runtime, message, state) => {
				return hasActionContextOrKeyword(message, state, {
					contexts: ["admin", "secrets", "settings"],
					keywords: [
						"sensitive action",
						"trust",
						"permission",
						"secret",
						"admin",
						"security",
					],
				});
			},
			handler: async (
				runtime,
				message,
				_state,
			): Promise<ActionResult | undefined> => {
				const permSystem = runtime.getService(
					"contextual-permissions",
				) as unknown as {
					checkAccess(request: AccessRequest): Promise<AccessDecision>;
				} | null;

				if (!permSystem) {
					logger.error("Permission system not available");
					return {
						success: false,
						text: "Permission system not available",
						error: "Permission system not available",
					};
				}

				const hasAccess = await permSystem.checkAccess({
					entityId: message.entityId,
					action: "sensitive-action",
					resource: "system",
					context: {
						roomId: message.roomId,
					},
				});

				if (!hasAccess.allowed) {
					return {
						success: false,
						text: "Access denied for sensitive action",
						error: "Access denied for sensitive action",
					};
				}

				logger.info("Executing sensitive action");
				return {
					success: true,
					text: "Sensitive action executed",
				};
			},
		},
	],
};
