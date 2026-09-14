/**
 * Keeps the authorized action catalog discoverable while a turn loads only the
 * schemas it needs. Discovery has no domain effects: it adds complete authorized
 * action families to this turn's native tools; the normal executor still checks
 * their permissions before dispatch.
 */
import { DISCOVER_TOOLS_NAME } from "../../actions/to-tool";
import { ElizaError } from "../../errors";
import { buildActionCatalog } from "../../runtime/action-catalog";
import { actionGateRejection } from "../../runtime/action-gate";
import type { Action } from "../../types/components";
import type { AgentContext, RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import { isObjectRecord } from "../../utils/type-guards";
import { mergeAgentContexts } from "./action-surface.js";
import { collectBudgetedStageOneCandidateActions } from "./planned-tool.js";

/**
 * The families DISCOVER_TOOLS may list and load: every registered action the
 * actor is authorized for under the action's OWN declared contexts — the same
 * rule the executor applies at dispatch (planned-tool.ts merges
 * `action.contexts` into the active set). The planner's exposed surface is
 * the Stage-1 context slice, and building the catalog from that slice meant a
 * misrouted turn could never load the family it needed: "read the last 3
 * messages in the #general discord channel" was routed to `general`, the
 * planner asked for MESSAGE, and the catalog (42 families, no MESSAGE)
 * rejected it, so the reply came from the wrong room (live 2026-09-14,
 * tj-ab82a95eb85149). Private, disclosure and role gates run unchanged with
 * the real message and roles; only the context term is per-action.
 */
export function collectDiscoveryCatalogActions(args: {
	actions: readonly Action[];
	message: Memory;
	selectedContexts: readonly AgentContext[];
	userRoles: readonly RoleGateRole[];
}): Action[] {
	return args.actions.filter(
		(action) =>
			actionGateRejection(action, {
				message: args.message,
				userRoles: args.userRoles,
				activeContexts: mergeAgentContexts(
					args.selectedContexts,
					action.contexts,
				),
			}) === undefined,
	);
}

export function createPlannerToolDiscoveryAction(
	authorizedActions: readonly Action[],
	onDiscover: (actions: Action[]) => void,
): Action {
	const actionsByName = new Map(
		authorizedActions.map((action) => [action.name, action]),
	);
	if (actionsByName.has(DISCOVER_TOOLS_NAME)) {
		throw new ElizaError(
			"Planner discovery name conflicts with a registered action",
			{
				code: "PLANNER_DISCOVERY_NAME_CONFLICT",
			},
		);
	}
	const catalog = buildActionCatalog(
		authorizedActions.map((action) => ({
			...action,
			subActions: action.subActions?.filter((child) =>
				actionsByName.has(typeof child === "string" ? child : child.name),
			),
		})),
	);
	return {
		name: DISCOVER_TOOLS_NAME,
		// Names and children only: the routing hints repeated a 14.9K-character
		// catalog in every planner round (audit 2026-09-13); a loaded family
		// carries its complete description on the next round. One line per
		// family rather than a JSON array: the same names cost ~1.1K fewer
		// characters on the live owner catalog (2026-09-14, 4,674 -> ~3,570),
		// the shape the Stage-1 available_actions catalog already uses.
		description:
			"Load complete tool schemas from the authorized catalog below when an exposed tool does not cover an intent. " +
			"Pass one or more exact parent or child names. All authorized operations of each selected family become callable on the next planner round. " +
			"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog. " +
			"One family per line as PARENT: child, child (a parent without children stands alone).\n" +
			catalog.parents
				.map((parent) =>
					parent.childNames.length > 0
						? `${parent.name}: ${parent.childNames.join(", ")}`
						: parent.name,
				)
				.join("\n"),
		parameters: [
			{
				name: "names",
				description: "Exact authorized parent or child tool names to load.",
				required: true,
				schema: { type: "array", items: { type: "string" } },
			},
		],
		validate: async () => true,
		handler: async (_runtime, _message, _state, options) => {
			const names = isObjectRecord(options?.parameters)
				? options.parameters.names
				: undefined;
			if (
				!Array.isArray(names) ||
				names.length === 0 ||
				!names.every(
					(name): name is string =>
						typeof name === "string" && actionsByName.has(name),
				)
			) {
				// A miss loads nothing and changes nothing: it steers the model
				// (coachingFailure) and never owns the turn's final message, which
				// otherwise shipped "the available runtime step failed" over a
				// later successful answer (live 2026-09-14, tj-8ce2f7a7e5384b).
				return {
					success: false,
					error:
						"Select exact names from the authorized discovery catalog. No tools were loaded.",
					data: { coachingFailure: true },
				};
			}
			const selected = collectBudgetedStageOneCandidateActions({
				actions: authorizedActions,
				candidateActions: names,
				contexts: [],
			});
			onDiscover(selected);
			return {
				success: true,
				turnComplete: false,
				text: "Tool schemas loaded. Continue with the requested work; discovery itself did not perform it.",
				data: { loadedTools: selected.map((action) => action.name) },
			};
		},
		examples: [],
	};
}
