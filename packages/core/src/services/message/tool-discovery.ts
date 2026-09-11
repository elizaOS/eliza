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
import type { ContextObject } from "../../types/context-object";
import type { ToolDefinition } from "../../types/model";
import { isObjectRecord } from "../../utils/type-guards";
import {
	collectBudgetedStageOneCandidateActions,
	collectPlannerTools,
} from "./planned-tool.js";

export function createPlannerToolDiscoveryAction(
	authorizedActions: readonly Action[],
	onDiscover: (actions: Action[]) => void,
	resolveAdditionalActions?: (names: string[]) => Promise<Action[]>,
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
			"Load complete tool schemas from the authorized name index below when an exposed tool does not cover an intent. " +
			"Pass exact parent or child names to load all authorized operations of those families. Pass names=[] to read the complete family descriptions and routing hints if the names alone are ambiguous. " +
			(resolveAdditionalActions
				? "The catalog lists families admitted for the current routing contexts. Other exact registered names may be requested; the same permission, context, account-policy and availability checks must admit them before loading. "
				: "") +
			"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.\n" +
			JSON.stringify(
				catalog.parents.map((parent) => ({
					name: parent.name,
					children: parent.childNames,
				})),
			),
		parameters: [
			{
				name: "names",
				description:
					"Exact authorized parent or child tool names to load; [] reads the full catalog descriptions without loading tools.",
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
				!names.every(
					(name): name is string => typeof name === "string" && name.length > 0,
				)
			) {
				return {
					success: false,
					error:
						"Select exact names from the authorized discovery catalog. No tools were loaded.",
				};
			}
			if (names.length === 0)
				return {
					success: true,
					turnComplete: false,
					text: "Complete authorized catalog descriptions. Select exact names to load schemas; no domain work was performed.",
					data: {
						catalog: catalog.parents.map((parent) => ({
							name: parent.name,
							description: parent.description,
							routingHint: parent.routingHint,
							children: parent.childNames,
						})),
					},
				};
			// Stage 1 can omit a domain even when the planner explicitly requests
			// its family. Reuse canonical candidate admission with that exact name;
			// never turn routing context into a permanent capability denial.
			const admitted = new Map(actionsByName);
			if (
				resolveAdditionalActions &&
				names.some((name) => !admitted.has(name))
			) {
				for (const action of await resolveAdditionalActions(names))
					admitted.set(action.name, action);
			}
			if (!names.every((name) => admitted.has(name))) {
				return {
					success: false,
					error:
						"Requested tool family was not admitted by the current capability and permission checks. No tools were loaded. Do not substitute an unrelated family for the requested operation.",
				};
			}
			for (const [name, action] of admitted) actionsByName.set(name, action);
			const selected = collectBudgetedStageOneCandidateActions({
				actions: [...actionsByName.values()],
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

/** Discovery adds only the requested family's complete schemas. Preserve the
 * existing budgeted definitions instead of expanding unrelated umbrellas. */
export function appendDiscoveredPlannerTools(
	context: ContextObject,
	current: ToolDefinition[],
	discovered: readonly Action[],
): void {
	const names = new Set(current.map((tool) => tool.name));
	for (const tool of collectPlannerTools(context, discovered)) {
		if (!names.has(tool.name)) {
			current.push(tool);
			names.add(tool.name);
		}
	}
}
