import type { RoleGateRole } from "../types/contexts";
import { normalizeGateRole, satisfiesRoleGate } from "./context-gates";

/**
 * Operator-supplied override map from the `ACTION_ROLE_POLICY` env var.
 *
 * Shape: `{"<ACTION_NAME>": "<RoleGateRole>", ...}` — e.g.
 * `{"BASH":"GUEST","WEB_FETCH":"MEMBER"}`.
 *
 * When an action name appears in this policy, its declared `contextGate` is
 * bypassed and access is decided solely by whether the caller satisfies the
 * policy's minimum role. Used to whitelist actions whose upstream
 * `contextGate` is narrower than a particular deployment needs.
 *
 * Lookup is honored in two places:
 *   - `executePlannedToolCall` (top-level planner picks)
 *   - `runSubPlanner` (sub-planner child action list)
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

/**
 * Returns the policy-mandated minimum role for `actionName` if it is
 * present in `ACTION_ROLE_POLICY` and the caller satisfies that role.
 * Returns `undefined` when the action is not whitelisted by the policy
 * or when the caller does not satisfy the policy role.
 */
export function isActionAllowedByRolePolicy(
	actionName: string,
	userRoles: readonly RoleGateRole[] | undefined,
): boolean {
	const policyRole = readActionRolePolicy()[actionName];
	if (!policyRole) {
		return false;
	}
	return satisfiesRoleGate(userRoles, { minRole: policyRole });
}

/** Test seam — clears the cached `ACTION_ROLE_POLICY` parse. */
export function _resetActionRolePolicyCacheForTests(): void {
	cachedActionRolePolicy = undefined;
}
