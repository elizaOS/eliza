/**
 * Keeps the authorized action catalog discoverable while a turn loads only the
 * schemas it needs. Discovery has no domain effects: it adds complete authorized
 * action families to this turn's native tools; the normal executor still checks
 * their permissions before dispatch.
 */
import { DISCOVER_TOOLS_NAME } from "../../actions/to-tool";
import { ElizaError } from "../../errors";
import { buildActionCatalog } from "../../runtime/action-catalog";
import type { Action } from "../../types/components";
import { isObjectRecord } from "../../utils/type-guards";
import { collectBudgetedStageOneCandidateActions } from "./planned-tool.js";

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
		description:
			"Load complete tool schemas from the authorized catalog below when an exposed tool does not cover an intent. " +
			"Pass one or more exact parent or child names. All authorized operations of each selected family become callable on the next planner round. " +
			"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.\n" +
			JSON.stringify(
				catalog.parents.map((parent) => ({
					name: parent.name,
					description: parent.routingHint || parent.description,
					children: parent.childNames,
				})),
			),
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
				return {
					success: false,
					error:
						"Select exact names from the authorized discovery catalog. No tools were loaded.",
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
