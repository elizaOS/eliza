/**
 * Keeps the authorized action catalog discoverable while a turn loads only the
 * schemas it needs. Discovery has no domain effects: it adds complete authorized
 * operations or explicitly requested families to this turn's native tools.
 * The normal executor still checks their permissions before dispatch.
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

/** Encode shared name prefixes reversibly; keep literal indexes when smaller. */
function renderDiscoveryNameIndex(
	parents: readonly { name: string; childNames: readonly string[] }[],
): string {
	const literal =
		"Index maps each exact family name to its exact child names (an empty list means no children):\n" +
		JSON.stringify(
			Object.fromEntries(
				parents.map((parent) => [parent.name, parent.childNames]),
			),
		);
	const factored =
		'Index maps each exact family name to its children. Arrays contain exact names; an object {"_":[suffixes]} means each child is the family name + "_" + suffix. Empty arrays mean no children:\n' +
		JSON.stringify(
			Object.fromEntries(
				parents.map(({ name, childNames }) => {
					const prefix = `${name}_`;
					const children =
						childNames.length > 0 &&
						childNames.every((child) => child.startsWith(prefix))
							? { _: childNames.map((child) => child.slice(prefix.length)) }
							: childNames;
					return [name, children];
				}),
			),
		);
	return factored.length < literal.length ? factored : literal;
}

export function createPlannerToolDiscoveryAction(
	authorizedActions: readonly Action[],
	onDiscover: (actions: Action[]) => void,
	/** Resolve named operations; [] requests fresh admission of the full catalog. */
	resolveAdditionalActions?: (names: string[]) => Promise<Action[]>,
	/** Keep legacy callers inline; reference mode uses the existing catalog read. */
	options?: { deferNameIndex?: boolean; catalogIndex?: boolean },
): Action {
	const catalogIndex = options?.catalogIndex === true;
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
	const catalogFor = (actions: readonly Action[]) => {
		const names = new Set(actions.map((action) => action.name));
		return buildActionCatalog(
			actions.map((action) => ({
				...action,
				subActions: action.subActions?.filter((child) =>
					names.has(typeof child === "string" ? child : child.name),
				),
			})),
			{ includeSearchMetadata: false },
		);
	};
	const catalog = catalogFor(authorizedActions);
	const inlineDescription =
		"Load complete tool schemas from the authorized name index below when an exposed tool does not cover an intent. " +
		"Pass exact child names to load those operations, or parent names to load their complete authorized families. For capability questions, use mode=describe with exact names from the index to read their complete descriptions without loading schemas. Use names=[] only when you need the complete catalog across families. " +
		(resolveAdditionalActions
			? "The inline index lists families admitted for the current routing contexts. If the needed domain is absent or its name is unknown, names=[] reads a fresh catalog across routing contexts. Other exact registered names may also be requested; the same permission, context, account-policy and availability checks must admit them before loading. "
			: "") +
		"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.\n" +
		renderDiscoveryNameIndex(catalog.parents);
	const referenceDescription =
		"Load complete tool schemas when an exposed tool does not cover an intent. " +
		"Pass exact known child names to load those operations, or parent names to load their complete authorized families. For capability questions, use mode=describe with exact known names to read their complete descriptions without loading schemas. Use names=[] only when you need the complete catalog across families. " +
		"No name index is preloaded here. " +
		(resolveAdditionalActions
			? "If the needed domain is absent or its name is unknown, names=[] reads a fresh catalog across routing contexts. Other exact registered names may also be requested; the same permission, context, account-policy and availability checks must admit them before loading. "
			: "If an exact name is unknown, names=[] reads the complete authorized catalog. ") +
		"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.";
	return {
		name: DISCOVER_TOOLS_NAME,
		description:
			options?.deferNameIndex &&
			referenceDescription.length < inlineDescription.length
				? referenceDescription +
					(catalogIndex
						? " Empty names returns a routing index; use mode=describe for complete descriptions."
						: "")
				: inlineDescription +
					(catalogIndex
						? " Empty names returns a routing index; use mode=describe for complete descriptions."
						: ""),
		parameters: [
			{
				name: "mode",
				description:
					"load (default) adds exact named schemas; describe reads only their complete descriptions. Neither executes domain work.",
				required: false,
				schema: { type: "string", enum: ["load", "describe"] },
			},
			{
				name: "names",
				description: catalogIndex
					? "Exact authorized names; [] reads the routing index, or full descriptions with mode=describe."
					: "Exact authorized parent or child names to load or describe; [] reads all catalog descriptions without loading tools.",
				required: true,
				schema: { type: "array", items: { type: "string" } },
			},
		],
		validate: async () => true,
		handler: async (_runtime, _message, _state, options) => {
			const mode = isObjectRecord(options?.parameters)
				? options.parameters.mode
				: undefined;
			const names = isObjectRecord(options?.parameters)
				? options.parameters.names
				: undefined;
			if (
				(mode !== undefined && mode !== "load" && mode !== "describe") ||
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
			if (names.length === 0 || mode === "describe") {
				// A mistaken Stage-1 domain must not make another authorized
				// domain undiscoverable. This explicit read refreshes admission;
				// it neither loads schemas nor changes execution permission.
				const freshActions = resolveAdditionalActions
					? await resolveAdditionalActions(names)
					: [...authorizedActions];
				const admittedNames = new Set(
					freshActions.map((action) => action.name),
				);
				if (!names.every((name) => admittedNames.has(name))) {
					return {
						success: false,
						error:
							"Requested descriptions were not admitted by current capability and permission checks. No tools were loaded. Use names=[] to inspect the current authorized catalog.",
					};
				}
				const completeCatalog = catalogFor(
					names.length === 0
						? freshActions
						: collectBudgetedStageOneCandidateActions({
								actions: freshActions,
								candidateActions: names,
								contexts: [],
								deferUnselectedContexts: true,
							}),
				);
				if (catalogIndex && names.length === 0 && mode !== "describe") {
					return {
						success: true,
						transcriptVisibility: "internal",
						modelReplyRequired: true,
						text: "Complete authorized name index. Summaries are for routing; use mode=describe with exact names for full descriptions, or mode=describe,names=[] for all descriptions. No tools were loaded or executed.",
						data: {
							readOnlyOperation: true,
							catalog: completeCatalog.parents.map((parent) => ({
								name: parent.name,
								routingHint:
									parent.routingHint ||
									parent.source.descriptionCompressed ||
									parent.source.description,
								children: parent.childNames,
							})),
						},
					};
				}
				return {
					success: true,
					transcriptVisibility: "internal",
					modelReplyRequired: true,
					text:
						names.length === 0
							? "Complete authorized catalog descriptions. Select exact names to load schemas; no domain work was performed."
							: "Complete descriptions for the requested authorized tools. Other families remain discoverable with names=[]. No schemas were loaded or domain work performed.",
					data: {
						readOnlyOperation: true,
						catalog: completeCatalog.parents.map((parent) => ({
							name: parent.name,
							description: parent.source.description,
							contexts: parent.source.contexts,
							similes: parent.source.similes,
							routingHint: parent.routingHint,
							children: parent.childNames,
							childDefinitions: parent.children.map((child) => ({
								name: child.name,
								description: child.source.description,
								contexts: child.source.contexts,
								similes: child.source.similes,
							})),
						})),
					},
				};
			}
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
						"Requested tool family was not admitted by the current capability and permission checks. No tools were loaded. Select an exact relevant name from availableNames, or use names=[] if you need complete catalog descriptions. Do not substitute an unrelated family for the requested operation.",
					data: {
						readOnlyOperation: true,
						availableNames: [...admitted.keys()],
					},
				};
			}
			for (const [name, action] of admitted) actionsByName.set(name, action);
			const selected = collectBudgetedStageOneCandidateActions({
				actions: [...actionsByName.values()],
				candidateActions: names,
				contexts: [],
				deferUnselectedContexts: true,
			});
			onDiscover(selected);
			return {
				success: true,
				transcriptVisibility: "internal",
				modelReplyRequired: true,
				text: "Tool schemas loaded. Only schema discovery ran; no domain action or data mutation ran. Continue with any requested domain work.",
				data: {
					readOnlyOperation: true,
					loadedTools: selected.map((action) => action.name),
				},
			};
		},
		examples: [],
	};
}

/** Discovery adds only the requested operations' complete schemas. Preserve the
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
