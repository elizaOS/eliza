/**
 * The single role/context/policy gate every action exposure and execution path
 * consults before an action may be surfaced to the planner or run — composing
 * the private-action gate, the operator role policy, the context gate, and the
 * top-level role gate in a fixed precedence.
 */

import { audienceAdmissionGateFailure } from "../access-control/audience-disclosure";
import {
	disclosureGateFailure,
	getTrustedDeliveryAudience,
} from "../security/trusted-delivery-audience";
import type { Action } from "../types/components";
import type { AgentContext, RoleGate, RoleGateRole } from "../types/contexts";
import type { Memory } from "../types/memory";
import { resolveActionRolePolicyRole } from "./action-role-policy";
import { satisfiesContextGate, satisfiesRoleGate } from "./context-gates";
import { privateActionAllowedOnTurn } from "./private-action-gate";

/**
 * The subset of {@link Action} fields the unified gate reads. Keeping the
 * parameter structural (rather than a full `Action`) lets non-runtime callers
 * gate a plain descriptor without constructing a handler.
 */
export type GateableAction = Pick<
	Action,
	| "name"
	| "private"
	| "contextGate"
	| "contexts"
	| "roleGate"
	| "disclosureGate"
>;

/**
 * Everything the gate needs about the current turn/actor. Deliberately a
 * structural subset of `ExecutePlannedToolCallContext` so the executor can pass
 * its context straight through.
 */
export interface ActionGateContext {
	message?: Memory;
	userRoles?: readonly RoleGateRole[];
	activeContexts?: readonly AgentContext[];
	/**
	 * Skip the private-action gate. Only static exposure/selection paths that do
	 * not correspond to a concrete turn (e.g. building a coding sub-agent's
	 * candidate-action set) may set this — the eventual execution still runs
	 * through the executor, which enforces the private gate. Execution paths MUST
	 * leave it `false` so a hallucinated or forced tool call cannot run a private
	 * (autonomy-only) action on a user turn.
	 */
	skipPrivateGate?: boolean;
}

export type ActionGateRejectionKind =
	| "private"
	| "disclosure"
	| "role"
	| "context";

export interface ActionGateRejection {
	kind: ActionGateRejectionKind;
	reason: string;
}

/**
 * The single role/context/policy gate deciding whether `action` may run for
 * `ctx` (#12087 Item 9). Composes, in order:
 *
 *   1. the private-action gate (unless `skipPrivateGate`),
 *   2. the non-overridable destination disclosure gate,
 *   3. the operator `ACTION_ROLE_POLICY` override — when set for this action it
 *      **replaces** the declared gates and access is decided solely by the
 *      policy role,
 *   4. the contextGate (derived from `contextGate ?? {contexts, roleGate}`),
 *   5. the top-level roleGate.
 *
 * Returns a human-readable failure reason, or `undefined` when the action is
 * allowed. Every exposure and execution path — planner selection, sub-planner
 * child filtering, the tool-call executor, and the shortcut gate — routes
 * through this one function so their outcomes cannot drift apart.
 */
export function actionGateRejection(
	action: GateableAction,
	ctx: ActionGateContext,
): ActionGateRejection | undefined {
	if (
		!ctx.skipPrivateGate &&
		!privateActionAllowedOnTurn(action, ctx.message)
	) {
		return {
			kind: "private",
			reason: `Action ${action.name} is private and can only run in the agent's autonomous loop`,
		};
	}

	const gate = action.disclosureGate;
	const disclosureFailure =
		gate?.require === "audience_admission"
			? audienceAdmissionGateFailure(
					gate.subject,
					getTrustedDeliveryAudience(ctx.message),
				)
			: disclosureGateFailure(gate, ctx.message);
	if (disclosureFailure) {
		return {
			kind: "disclosure",
			reason: `Action ${action.name} is not allowed: ${disclosureFailure}`,
		};
	}

	const policyRole = resolveActionRolePolicyRole(action);
	if (policyRole) {
		return satisfiesRoleGate(ctx.userRoles, { minRole: policyRole })
			? undefined
			: {
					kind: "role",
					reason: `Action ${action.name} is not allowed for the current role`,
				};
	}

	const contextRoleGate = action.contextGate?.roleGate ?? action.roleGate;
	if (!satisfiesRoleGate(ctx.userRoles, contextRoleGate)) {
		return {
			kind: "role",
			reason: `Action ${action.name} is not allowed for the current role`,
		};
	}

	const contextGate = action.contextGate ?? { contexts: action.contexts };
	if (!satisfiesContextGate(ctx.activeContexts, contextGate, ctx.userRoles)) {
		return {
			kind: "context",
			reason: `Action ${action.name} is not allowed in the current context`,
		};
	}

	if (
		!satisfiesRoleGate(ctx.userRoles, action.roleGate as RoleGate | undefined)
	) {
		return {
			kind: "role",
			reason: `Action ${action.name} is not allowed for the current role`,
		};
	}

	return undefined;
}

/** Human-readable compatibility form of {@link actionGateRejection}. */
export function actionGateFailure(
	action: GateableAction,
	ctx: ActionGateContext,
): string | undefined {
	return actionGateRejection(action, ctx)?.reason;
}

/** Boolean form of {@link actionGateFailure}. */
export function canActionRun(
	action: GateableAction,
	ctx: ActionGateContext,
): boolean {
	return actionGateFailure(action, ctx) === undefined;
}
