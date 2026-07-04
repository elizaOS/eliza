/**
 * Reads, caches, and applies the operator `ACTION_ROLE_POLICY` override:
 * per-action minimum-role resolution, role-based authorization checks, and
 * startup warnings for policy keys that loosen a declared gate or match no
 * registered action.
 */
import { logger } from "../logger";
import type { RoleGateRole } from "../types/contexts";
import {
	normalizeGateRole,
	roleRank,
	satisfiesRoleGate,
} from "./context-gates";

/**
 * Operator-supplied override map from the `ACTION_ROLE_POLICY` env var.
 *
 * Shape: `{"<ACTION_NAME>": "<RoleGateRole>", ...}` — e.g.
 * `{"SHELL":"GUEST","BROWSER":"MEMBER"}`.
 *
 * When an exact action name appears in this policy, its declared `contextGate`
 * is bypassed and access is decided solely by whether the caller satisfies the
 * policy's minimum role. Used to whitelist actions whose upstream `contextGate`
 * is narrower than a particular deployment needs.
 *
 * The policy is evaluated in exactly one place — the shared `actionGateFailure`
 * / `canActionRun` gate in `runtime/action-gate.ts` (#12087 Item 9) — which every
 * exposure/execution path (planner, sub-planner, tool-call executor, shortcut
 * gate) routes through. A policy key that matches no registered action name or
 * simile is silently inert; `warnOnUnmatchedActionRolePolicyKeys` surfaces that at
 * startup (#12087 Item 19).
 */

let cachedActionRolePolicy: Record<string, RoleGateRole> | undefined;

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

export function readActionRolePolicy(): Record<string, RoleGateRole> {
	if (cachedActionRolePolicy !== undefined) {
		return cachedActionRolePolicy;
	}
	const raw = process.env.ACTION_ROLE_POLICY;
	if (!raw) {
		cachedActionRolePolicy = {};
		return cachedActionRolePolicy;
	}
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			cachedActionRolePolicy = {};
			return cachedActionRolePolicy;
		}
		cachedActionRolePolicy = Object.fromEntries(
			Object.entries(parsed)
				.map(([actionName, role]) => [
					actionName,
					parseActionRolePolicyRole(role),
				])
				.filter((entry): entry is [string, RoleGateRole] => Boolean(entry[1])),
		);
	} catch {
		cachedActionRolePolicy = {};
	}
	return cachedActionRolePolicy;
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
	const policy = readActionRolePolicy();
	if (typeof action === "string") return policy[action];
	return policy[action.name];
}

/**
 * Returns the policy-mandated minimum role for `actionName` if it is
 * present in `ACTION_ROLE_POLICY` and the caller satisfies that role.
 * Returns `undefined` when the action is not whitelisted by the policy
 * or when the caller does not satisfy the policy role.
 */
export function isActionAllowedByRolePolicy(
	action: string | PolicyAddressableAction,
	userRoles: readonly RoleGateRole[] | undefined,
): boolean {
	const policyRole = resolveActionRolePolicyRole(action);
	if (!policyRole) {
		return false;
	}
	return satisfiesRoleGate(userRoles, { minRole: policyRole });
}

function declaredMinimumRole(
	action: PolicyAddressableAction,
): RoleGateRole | undefined {
	const roles = [
		action.contextGate?.roleGate?.minRole,
		action.roleGate?.minRole,
	].filter((role): role is RoleGateRole => Boolean(role));
	if (roles.length === 0) return undefined;
	return roles.reduce((strictest, role) =>
		roleRank(role) > roleRank(strictest) ? role : strictest,
	);
}

export function getActionRolePolicyWarnings(
	actions: readonly PolicyAddressableAction[],
): ActionRolePolicyWarning[] {
	const policy = readActionRolePolicy();
	const byName = new Map(actions.map((action) => [action.name, action]));
	const warnings: ActionRolePolicyWarning[] = [];

	for (const [actionName, policyRole] of Object.entries(policy)) {
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
