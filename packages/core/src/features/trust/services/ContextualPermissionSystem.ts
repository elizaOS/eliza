import { logger } from "../../../logger.ts";
import { getUserServerRole } from "../../../roles.ts";
import { type IAgentRuntime, Role, type UUID } from "../../../types/index.ts";
import { stringToUuid } from "../../../utils.ts";
import type {
	AccessDecision,
	AccessRequest,
	ElevationRequest,
	ElevationResult,
	PermissionDecision as IPermissionDecision,
	Permission,
	PermissionContext,
	PermissionDelegation,
} from "../types/permissions.ts";
import type { SecurityModule } from "./SecurityModule.ts";
import type { TrustEngine } from "./TrustEngine.ts";

export class ContextualPermissionSystem {
	private runtime!: IAgentRuntime;
	private trustEngine!: TrustEngine;
	private securityModule!: SecurityModule;

	private permissionCache = new Map<
		string,
		{ decision: AccessDecision; expiry: number }
	>();
	private elevations = new Map<
		string,
		ElevationRequest & { expiresAt: number }
	>();
	private delegations = new Map<UUID, PermissionDelegation[]>();

	private static readonly ROLE_PERMISSIONS: Record<string, Set<string>> = {
		[Role.OWNER]: new Set(["*"]),
		[Role.ADMIN]: new Set([
			"manage_roles",
			"manage_settings",
			"moderate_content",
			"timeout_user",
			"delete_content",
			"view_audit_log",
			"evaluate_trust",
			"record_trust",
			"view_trust_profiles",
			"manage_channels",
			"ban_user",
		]),
		[Role.NONE]: new Set([
			"send_message",
			"view_content",
			"evaluate_trust",
			"view_trust_profiles",
			"request_elevation",
		]),
	};

	private static readonly TRUST_ACTION_THRESHOLDS: Record<string, number> = {
		view_audit_log: 80,
		view_trust_profiles: 60,
		flag_content: 90,
		report_user: 70,
		request_elevation: 50,
	};

	private static readonly TRUST_ONLY_ACTIONS = new Set([
		"view_audit_log",
		"view_trust_profiles",
		"flag_content",
		"report_user",
		"request_elevation",
	]);

	private static readonly ADMIN_ONLY_ACTIONS = new Set([
		"manage_roles",
		"manage_settings",
		"manage_channels",
		"ban_user",
		"delete_content",
	]);

	async initialize(
		runtime: IAgentRuntime,
		trustEngine: TrustEngine,
		securityModule: SecurityModule,
	): Promise<void> {
		this.runtime = runtime;
		this.trustEngine = trustEngine;
		this.securityModule = securityModule;
	}

	async hasPermission(
		entityId: UUID,
		permission: Permission,
		context: PermissionContext,
	): Promise<boolean> {
		const decision = await this.checkAccess({
			entityId,
			action: permission.action,
			resource: permission.resource,
			context,
		});
		return decision.allowed;
	}

	async checkAccess(request: AccessRequest): Promise<AccessDecision> {
		const cacheKey = JSON.stringify(request);
		const cached = this.permissionCache.get(cacheKey);
		if (cached && cached.expiry > Date.now()) {
			return cached.decision;
		}

		// Security Module Checks
		const content = `${request.action} on ${request.resource}`;
		const injectionCheck = await this.securityModule.detectPromptInjection(
			content,
			{
				...request.context,
				entityId: request.entityId,
				requestedAction: content,
			},
		);
		if (injectionCheck.detected && injectionCheck.action === "block") {
			return this.createDecision(request, {
				allowed: false,
				method: "denied",
				reason: `Security block: ${injectionCheck.details}`,
			});
		}

		// Role-based check
		const roleDecision = await this.checkRolePermissions(request);
		if (roleDecision.allowed) {
			return this.createDecision(request, roleDecision);
		}

		// Trust-based check
		const trustDecision = await this.checkTrustPermissions(request);
		if (trustDecision.allowed) {
			return this.createDecision(request, trustDecision);
		}

		// Elevation check -- active temporary grants
		const elevationDecision = this.checkActiveElevations(request);
		if (elevationDecision.allowed) {
			return this.createDecision(request, elevationDecision);
		}

		// Delegation check
		const delegationDecision = await this.checkDelegatedPermissions(request);
		if (delegationDecision.allowed) {
			return this.createDecision(request, delegationDecision);
		}

		const reason = this.generateDenialReason(
			roleDecision,
			trustDecision,
			delegationDecision,
		);
		return this.createDecision(request, {
			allowed: false,
			method: "denied",
			reason,
		});
	}

	private async checkRolePermissions(
		request: AccessRequest,
	): Promise<IPermissionDecision> {
		const roles = await this.getEntityRoles(request.entityId, request.context);
		for (const role of roles) {
			if (this.roleHasPermission(role, request.action, request.resource)) {
				return {
					allowed: true,
					method: "role-based",
					reason: `Allowed by role: ${role}`,
				};
			}
		}
		return {
			allowed: false,
			method: "denied",
			reason: "No matching role permission",
		};
	}

	private async checkTrustPermissions(
		request: AccessRequest,
	): Promise<IPermissionDecision> {
		// Trust alone should NEVER grant write/admin actions
		if (!ContextualPermissionSystem.TRUST_ONLY_ACTIONS.has(request.action)) {
			return {
				allowed: false,
				method: "denied",
				reason: "Trust alone cannot grant this action",
			};
		}

		const threshold =
			ContextualPermissionSystem.TRUST_ACTION_THRESHOLDS[request.action];
		if (threshold === undefined) {
			return {
				allowed: false,
				method: "denied",
				reason: "No trust threshold defined for this action",
			};
		}

		const trustProfile = await this.trustEngine.calculateTrust(
			request.entityId,
			{
				...request.context,
				evaluatorId: this.runtime.agentId,
			},
		);

		if (trustProfile.overallTrust >= threshold) {
			return {
				allowed: true,
				method: "trust-based",
				reason: `Allowed by trust score ${trustProfile.overallTrust.toFixed(2)} (threshold: ${threshold})`,
			};
		}

		return {
			allowed: false,
			method: "denied",
			reason: `Insufficient trust: ${trustProfile.overallTrust.toFixed(2)} < ${threshold}`,
		};
	}

	private async checkDelegatedPermissions(
		request: AccessRequest,
	): Promise<IPermissionDecision> {
		const entityDelegations: PermissionDelegation[] =
			this.delegations.get(request.entityId) ?? [];

		for (const delegation of entityDelegations) {
			if (delegation.revoked) continue;
			if (delegation.expiresAt && delegation.expiresAt < Date.now()) continue;

			const matchingPermission = delegation.permissions.find(
				(p) => p.action === request.action && p.resource === request.resource,
			);

			if (matchingPermission) {
				return {
					allowed: true,
					method: "delegated",
					reason: `Allowed by delegation from ${delegation.delegatorId}`,
				};
			}
		}

		return {
			allowed: false,
			method: "denied",
			reason: "No valid delegation found",
		};
	}

	async requestElevation(request: ElevationRequest): Promise<ElevationResult> {
		const action = request.requestedPermission.action;

		// Admin-level actions cannot be granted via elevation
		if (ContextualPermissionSystem.ADMIN_ONLY_ACTIONS.has(action)) {
			return {
				granted: false,
				reason: `Action "${action}" cannot be granted via elevation`,
				suggestions: ["Request a role assignment from an administrator"],
			};
		}

		const trustProfile = await this.trustEngine.calculateTrust(
			request.entityId,
			{
				...request.context,
				evaluatorId: this.runtime.agentId,
			},
		);

		const requiredTrust = 70;
		if (trustProfile.overallTrust < requiredTrust) {
			return {
				granted: false,
				reason: "Insufficient trust for elevation",
				trustDeficit: requiredTrust - trustProfile.overallTrust,
				suggestions: [
					"Build trust through positive interactions",
					`Current trust: ${trustProfile.overallTrust.toFixed(2)}, required: ${requiredTrust}`,
				],
			};
		}

		const elevationId = stringToUuid(JSON.stringify(request));
		const durationMs = (request.duration ?? 5 * 60) * 1000;
		const expiresAt = Date.now() + durationMs;
		this.elevations.set(elevationId, { ...request, expiresAt });

		// Log the elevation for audit
		logger.info(
			{
				entityId: request.entityId,
				action,
				expiresAt: new Date(expiresAt).toISOString(),
			},
			"[ContextualPermissionSystem] Elevation granted",
		);

		return {
			granted: true,
			elevationId,
			expiresAt,
			conditions: [`Expires at ${new Date(expiresAt).toISOString()}`],
			reason: `Elevation granted based on trust score ${trustProfile.overallTrust.toFixed(2)}`,
		};
	}

	/**
	 * Check if the entity has an active (non-expired) elevation grant for the requested action.
	 */
	private checkActiveElevations(request: AccessRequest): IPermissionDecision {
		for (const [id, elevation] of this.elevations) {
			// Prune expired elevations
			if (elevation.expiresAt < Date.now()) {
				this.elevations.delete(id);
				continue;
			}
			if (
				elevation.entityId === request.entityId &&
				elevation.requestedPermission.action === request.action
			) {
				return {
					allowed: true,
					method: "elevated",
					reason: `Allowed by active elevation (expires ${new Date(elevation.expiresAt).toISOString()})`,
				};
			}
		}
		return { allowed: false, method: "denied", reason: "No active elevation" };
	}

	/**
	 * Create a delegation granting another entity specific permissions.
	 */
	addDelegation(delegation: PermissionDelegation): void {
		const existing = this.delegations.get(delegation.delegateeId) ?? [];
		existing.push(delegation);
		this.delegations.set(delegation.delegateeId, existing);
		logger.info(
			{
				delegatorId: delegation.delegatorId,
				delegateeId: delegation.delegateeId,
				permissions: delegation.permissions.length,
			},
			"[ContextualPermissionSystem] Delegation created",
		);
	}

	/**
	 * Revoke a delegation by ID.
	 */
	revokeDelegation(delegationId: UUID, revokedBy: UUID): boolean {
		for (const [, delegations] of this.delegations) {
			const target = delegations.find((d) => d.id === delegationId);
			if (target) {
				target.revoked = true;
				target.revokedAt = Date.now();
				target.revokedBy = revokedBy;
				return true;
			}
		}
		return false;
	}

	private createDecision(
		request: AccessRequest,
		partialDecision: Partial<AccessDecision>,
	): AccessDecision {
		const decision: AccessDecision = {
			request,
			allowed: partialDecision.allowed || false,
			method: partialDecision.method || "denied",
			reason: partialDecision.reason || "",
			evaluatedAt: Date.now(),
			...partialDecision,
		};
		if (decision.allowed) {
			const cacheKey = JSON.stringify(request);
			this.permissionCache.set(cacheKey, {
				decision,
				expiry: Date.now() + (decision.ttl || 300000),
			});
		}
		return decision;
	}

	private roleHasPermission(
		roleName: Role | string,
		action: string,
		_resource: string,
	): boolean {
		const permissions = ContextualPermissionSystem.ROLE_PERMISSIONS[roleName];
		if (!permissions) return false;
		return permissions.has("*") || permissions.has(action);
	}

	private async getEntityRoles(
		entityId: UUID,
		context: PermissionContext,
	): Promise<string[]> {
		if (context.worldId) {
			const role = await getUserServerRole(
				this.runtime,
				entityId,
				context.worldId,
			);
			return role ? [role] : [];
		}
		return [];
	}

	private generateDenialReason(
		roleDecision: IPermissionDecision,
		trustDecision: IPermissionDecision,
		delegationDecision: IPermissionDecision,
	): string {
		return `Access denied. Role check: ${roleDecision.reason}. Trust check: ${trustDecision.reason}. Delegation check: ${delegationDecision.reason}.`;
	}
}
