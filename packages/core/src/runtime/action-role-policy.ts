/**
 * Reads, caches, and applies the operator `ACTION_ROLE_POLICY` override:
 * per-action minimum-role resolution, role-based authorization checks, and
 * startup warnings for policy keys that loosen a declared gate or match no
 * registered action.
 */
import { ElizaError } from "../errors";
import { logger } from "../logger";
import type { RoleGateRole } from "../types/contexts";
import { normalizeGateRole, roleRank } from "./context-gates";

/**
 * Operator-supplied override map from the `ACTION_ROLE_POLICY` env var.
 *
 * Shape: `{"<ACTION_NAME>": "<RoleGateRole>",...}` — e.g.
 * `{"SHELL":"GUEST","BROWSER":"MEMBER"}`.
 *
 * When an exact action name appears in this policy, its declared `contextGate`
 * is bypassed and access is decided solely by whether the caller satisfies the
 * policy's minimum role. Used to whitelist actions whose upstream `contextGate`
 * is narrower than a particular deployment needs. A minimum role can never
 * refuse an OWNER caller (or the agent itself); a host that must keep an
 * action away from every caller uses `ELIZA_ACTION_ALLOWLIST` instead.
 *
 * The policy is evaluated in exactly one place — the shared `actionGateFailure`
 * / `canActionRun` gate in `runtime/action-gate.ts` — which every
 * exposure/execution path (planner, sub-planner, tool-call executor, shortcut
 * gate) routes through. A policy key that matches no registered action name or
 * simile is silently inert; `warnOnUnmatchedActionRolePolicyKeys` surfaces that at
 * startup.
 */

let cachedActionRolePolicy: ReadonlyMap<string, RoleGateRole> | undefined;

const ACTION_ROLE_POLICY_ROLES = new Set<RoleGateRole>([
	"NONE",
	"GUEST",
	"MEMBER",
	"ADMIN",
	"OWNER",
]);

function parseActionRolePolicyRole(value: unknown): RoleGateRole | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = normalizeGateRole(value as RoleGateRole);
	return ACTION_ROLE_POLICY_ROLES.has(normalized) ? normalized : undefined;
}

function readActionRolePolicy(): ReadonlyMap<string, RoleGateRole> {
	if (cachedActionRolePolicy !== undefined) {
		return cachedActionRolePolicy;
	}
	const raw = process.env.ACTION_ROLE_POLICY;
	if (!raw) {
		cachedActionRolePolicy = new Map();
		return cachedActionRolePolicy;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		// error-policy:J2 Operator authorization policy is a security boundary;
		// malformed configuration must fail startup rather than disable the policy.
		throw new ElizaError("Failed to parse ACTION_ROLE_POLICY", {
			code: "INVALID_ACTION_ROLE_POLICY",
			cause: error,
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ElizaError("ACTION_ROLE_POLICY must be a JSON object", {
			code: "INVALID_ACTION_ROLE_POLICY",
		});
	}
	const policy = new Map<string, RoleGateRole>();
	for (const [actionName, value] of Object.entries(parsed)) {
		const role = parseActionRolePolicyRole(value);
		if (!role) {
			throw new ElizaError("ACTION_ROLE_POLICY contains an invalid role", {
				code: "INVALID_ACTION_ROLE_POLICY",
				context: { actionName },
			});
		}
		policy.set(actionName, role);
	}
	cachedActionRolePolicy = policy;
	return policy;
}

type PolicyAddressableAction = {
	name: string;
	contextGate?: {
		roleGate?: {
			minRole?: RoleGateRole;
		};
	};
	roleGate?: {
		minRole?: RoleGateRole;
	};
};

export type ActionRolePolicyWarning =
	| {
			type: "unmatched";
			actionName: string;
			policyRole: RoleGateRole;
	  }
	| {
			type: "loosens";
			actionName: string;
			policyRole: RoleGateRole;
			declaredRole: RoleGateRole;
	  };

export function resolveActionRolePolicyRole(
	action: string | PolicyAddressableAction,
): RoleGateRole | undefined {
	return readActionRolePolicy().get(
		typeof action === "string" ? action : action.name,
	);
}

/** The stricter of the action's declared minimum roles. */
function declaredMinimumRole(
	action: PolicyAddressableAction,
): RoleGateRole | undefined {
	const contextRole = action.contextGate?.roleGate?.minRole;
	const topLevelRole = action.roleGate?.minRole;
	if (!contextRole) return topLevelRole;
	if (!topLevelRole) return contextRole;
	return roleRank(topLevelRole) > roleRank(contextRole)
		? topLevelRole
		: contextRole;
}

export function getActionRolePolicyWarnings(
	actions: readonly PolicyAddressableAction[],
): ActionRolePolicyWarning[] {
	const policy = readActionRolePolicy();
	const byName = new Map(actions.map((action) => [action.name, action]));
	const warnings: ActionRolePolicyWarning[] = [];

	for (const [actionName, policyRole] of policy) {
		const action = byName.get(actionName);
		if (!action) {
			warnings.push({ type: "unmatched", actionName, policyRole });
			continue;
		}
		const declaredRole = declaredMinimumRole(action);
		if (declaredRole && roleRank(policyRole) < roleRank(declaredRole)) {
			warnings.push({
				type: "loosens",
				actionName,
				policyRole,
				declaredRole,
			});
		}
	}

	return warnings;
}

/**
 * Warn about `ACTION_ROLE_POLICY` keys that match no registered action name.
 * Policy lookup is exact-name only; similes intentionally do not authorize.
 * Returns the unmatched keys for tests.
 */
export function warnOnUnmatchedActionRolePolicyKeys(
	actions: readonly PolicyAddressableAction[],
): string[] {
	const warnings = getActionRolePolicyWarnings(actions);
	const unmatched = warnings
		.filter((warning) => warning.type === "unmatched")
		.map((warning) => warning.actionName);
	if (unmatched.length > 0) {
		logger.warn(
			`[action-role-policy] ACTION_ROLE_POLICY key(s) match no registered action name and are inert: ${unmatched.join(", ")}`,
		);
	}
	return unmatched;
}

/** Test seam — clears the cached `ACTION_ROLE_POLICY` parse. */
export function _resetActionRolePolicyCacheForTests(): void {
	cachedActionRolePolicy = undefined;
}
