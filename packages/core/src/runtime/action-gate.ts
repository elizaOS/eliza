/**
 * The single role/context/policy gate every action exposure and execution path
 * consults before an action may be surfaced to the planner or run — composing
 * the private-action gate, the operator role policy, the context gate, and the
 * top-level role gate in a fixed precedence.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { audienceAdmissionGateFailure } from "../access-control/audience-disclosure";
import { ElizaError } from "../errors";
import { checkSenderRole } from "../roles";
import {
	disclosureGateFailure,
	getTrustedDeliveryAudience,
} from "../security/trusted-delivery-audience";
import type { Action } from "../types/components";
import type { AgentContext, RoleGate, RoleGateRole } from "../types/contexts";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import { resolveActionRolePolicyRole } from "./action-role-policy";
import { satisfiesContextGate, satisfiesRoleGate } from "./context-gates";

/**
 * The subset of {@link Action} fields the unified gate reads. Keeping the
 * parameter structural (rather than a full `Action`) lets non-runtime callers
 * gate a plain descriptor without constructing a handler.
 */
export type GateableAction = Pick<
	Action,
	| "name"
	| "tags"
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

/** Host-established request restrictions apply to discovery and execution alike. */
const requestPolicy = new AsyncLocalStorage<
	(action: GateableAction, context: ActionGateContext) => string | undefined
>();
export function withActionGatePolicy<T>(
	policy: (
		action: GateableAction,
		context: ActionGateContext,
	) => string | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const inherited = requestPolicy.getStore();
	return requestPolicy.run(
		(action, context) =>
			inherited?.(action, context) ?? policy(action, context),
		run,
	);
}

/**
 * The single role/context/policy gate deciding whether `action` may run for
 * `ctx`. Composes, in order:
 *
 * 1. the private-action gate (unless `skipPrivateGate`),
 * 2. the non-overridable destination disclosure gate,
 * 3. the operator `ACTION_ROLE_POLICY` override — when set for this action it
 * **replaces** the declared gates and access is decided solely by the
 * policy role,
 * 4. the contextGate (derived from `contextGate ?? {contexts, roleGate}`),
 * 5. the top-level roleGate.
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

	const requestFailure = requestPolicy.getStore()?.(action, ctx);
	if (requestFailure) return { kind: "context", reason: requestFailure };

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

/**
 * Resolve the caller's canonical role for gate evaluation. The agent itself is
 * OWNER; a missing canonical room/world is GUEST (the non-authorizing floor);
 * a role-store failure throws rather than guessing a role.
 */
export async function resolveActionCallerRoles(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<RoleGateRole[]> {
	if (
		typeof message.entityId === "string" &&
		message.entityId === runtime.agentId
	) {
		return ["OWNER"];
	}

	try {
		const result = await checkSenderRole(runtime, message);
		if (result?.role) {
			return [result.role as RoleGateRole];
		}
	} catch (error) {
		// error-policy:J2 A role-store failure cannot be converted into a role
		// because doing so would authorize actions without canonical evidence.
		throw new ElizaError("Failed to resolve the tool caller's role", {
			code: "ACTION_CALLER_ROLE_LOOKUP_FAILED",
			cause: error,
			context: {
				messageId: message.id,
				roomId: message.roomId,
				entityId: message.entityId,
			},
		});
	}

	return ["GUEST"];
}

/** True when evaluating `action` needs the caller's resolved role. */
export function actionGateNeedsCallerRoles(action: GateableAction): boolean {
	return Boolean(
		action.roleGate ||
			action.contextGate?.roleGate ||
			resolveActionRolePolicyRole(action),
	);
}

/**
 * {@link actionGateFailure} for a concrete turn, resolving the caller's role
 * only when the action declares a role requirement. Used by execution paths
 * that do not come through the planned tool-call executor (mode hooks, plan
 * steps) so every path applies the same gate.
 */
export async function resolveActionGateFailure(
	runtime: IAgentRuntime,
	action: GateableAction,
	ctx: Omit<ActionGateContext, "message" | "skipPrivateGate"> & {
		message: Memory;
		/**
		 * `false` for paths that never selected contexts for this execution
		 * (non-CONTEXT mode hooks, plan steps): context declarations are routing
		 * metadata there, while private/disclosure/role requirements still apply.
		 */
		evaluateContexts?: boolean;
	},
): Promise<string | undefined> {
	const gated: GateableAction =
		ctx.evaluateContexts === false
			? {
					name: action.name,
					tags: action.tags,
					private: action.private,
					roleGate: action.roleGate,
					disclosureGate: action.disclosureGate,
					contextGate: action.contextGate?.roleGate
						? { roleGate: action.contextGate.roleGate }
						: undefined,
				}
			: action;
	return actionGateFailure(gated, {
		...ctx,
		userRoles:
			ctx.userRoles?.length || !actionGateNeedsCallerRoles(action)
				? ctx.userRoles
				: await resolveActionCallerRoles(runtime, ctx.message),
	});
}

/**
 * Gate that keeps `private` actions off any non-autonomous turn — exposing and
 * executing them only when the triggering message is one of the autonomy
 * service's own self-prompts.
 */

/**
 * "Private" actions (see {@link Action.private}) may only run inside the
 * agent's own autonomous loop, never in direct response to a user request.
 *
 * A turn is treated as autonomous when the triggering message carries
 * `content.metadata.isAutonomous === true` — the marker the autonomy service
 * stamps on its self-prompts. Any other message (a real user turn, a connector
 * inbound, a sub-agent dispatch) is non-autonomous and a private action must be
 * withheld.
 *
 * The marker is trustworthy here because inbound messages are stripped of a
 * forged `isAutonomous` upstream: `hardenIncomingUserMessage`
 * removes it from every
 * message whose source is not the autonomy service, so a connector forwarding
 * client-supplied metadata cannot use it to unlock private actions.
 */
function isAutonomousTurn(message: Memory | undefined): boolean {
	const metadata = message?.content?.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return false;
	}
	return (metadata as { isAutonomous?: unknown }).isAutonomous === true;
}

/**
 * Returns true when `action` is allowed to be exposed/executed on the current
 * turn given its private-mode flag. Private actions are allowed only on
 * autonomous turns; non-private actions are always allowed.
 */
function privateActionAllowedOnTurn(
	action: Pick<Action, "private">,
	message: Memory | undefined,
): boolean {
	if (!action.private) {
		return true;
	}
	return isAutonomousTurn(message);
}
