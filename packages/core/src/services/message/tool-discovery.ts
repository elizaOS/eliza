/**
 * Keeps the authorized action catalog discoverable while a turn loads only the
 * schemas it needs. Discovery has no domain effects: it adds complete authorized
 * operations or explicitly requested families to this turn's native tools.
 * The normal executor still checks their permissions before dispatch.
 */
import { normalizeActionJsonSchema } from "../../actions/action-schema";
import { DISCOVER_TOOLS_NAME } from "../../actions/to-tool";
import { ElizaError } from "../../errors";
import { buildActionCatalog } from "../../runtime/action-catalog";
import { actionGateRejection } from "../../runtime/action-gate";
import type { Action } from "../../types/components";
import type { ContextObject } from "../../types/context-object";
import type { AgentContext, RoleGateRole } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import type { ToolDefinition } from "../../types/model";
import { isObjectRecord } from "../../utils/type-guards";
import { mergeAgentContexts } from "./action-surface.js";
import {
	collectBudgetedStageOneCandidateActions,
	collectPlannerTools,
} from "./planned-tool.js";

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
	onDiscover: (actions: Action[], requestedNames: readonly string[]) => void,
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
	const catalogReadHint = catalogIndex
		? "To find unknown tool names, use mode=load with names=[] for the authorized routing index, then load exact names. Use mode=describe with names=[] only when you need every family's complete descriptions and routing hints. "
		: "Pass names=[] to read the complete family descriptions and routing hints if the names alone are ambiguous. ";
	const inlineDescription =
		"Load complete tool schemas from the authorized name index below when an exposed tool does not cover an intent. " +
		"Pass exact child names to load those operations, or parent names to load their complete authorized families. For capability or parameter questions, use mode=describe with exact names to read descriptions and parameter schemas without enabling tools. " +
		catalogReadHint +
		(resolveAdditionalActions
			? "The inline index lists families admitted for the current routing contexts. If the needed domain is absent or its name is unknown, names=[] reads a fresh catalog across routing contexts. Other exact registered names may also be requested; the same permission, context, account-policy and availability checks must admit them before loading. "
			: "") +
		"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.\n" +
		renderDiscoveryNameIndex(catalog.parents);
	const referenceDescription =
		"Load complete tool schemas when an exposed tool does not cover an intent. " +
		"Pass exact known child names to load those operations, or parent names to load their complete authorized families. For capability or parameter questions, use mode=describe with exact names to read descriptions and parameter schemas without enabling tools. " +
		catalogReadHint +
		"No name index is preloaded here. " +
		(resolveAdditionalActions
			? "If the needed domain is absent or its name is unknown, names=[] reads a fresh catalog across routing contexts. Other exact registered names may also be requested; the same permission, context, account-policy and availability checks must admit them before loading. "
			: "If an exact name is unknown, names=[] reads the complete authorized catalog. ") +
		"Discovery does not execute the requested work; continue with the loaded tools. Do not claim a capability is unavailable before checking this catalog.";
	return {
		name: DISCOVER_TOOLS_NAME,
		// Names and children only: the routing hints repeated a 14.9K-character
		// catalog in every planner round (audit 2026-09-13); a loaded family
		// carries its complete description on the next round. One line per
		// family rather than a JSON array: the same names cost ~1.1K fewer
		// characters on the live owner catalog (2026-09-14, 4,674 -> ~3,570),
		// the shape the Stage-1 available_actions catalog already uses.
		description:
			options?.deferNameIndex &&
			referenceDescription.length < inlineDescription.length
				? referenceDescription
				: inlineDescription,
		parameters: [
			{
				name: "mode",
				description:
					"load (default) enables named tools; describe reads complete descriptions and, for named tools, parameter schemas. Neither executes domain work.",
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
				// A miss loads nothing and changes nothing: it steers the model
				// (coachingFailure) and never owns the turn's final message, which
				// otherwise shipped "the available runtime step failed" over a
				// later successful answer (live 2026-09-14, tj-8ce2f7a7e5384b).
				return {
					success: false,
					error:
						"Select exact names from the authorized discovery catalog. No tools were loaded.",
					data: { readOnlyOperation: true, coachingFailure: true },
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
						// Like an unavailable load request, this lookup changed no
						// state. Keep the rejection visible to planning without making
						// it override a later successfully evaluated domain result.
						data: { readOnlyOperation: true },
					};
				}
				const describedActions =
					names.length === 0
						? freshActions
						: collectBudgetedStageOneCandidateActions({
								actions: freshActions,
								candidateActions: names,
								contexts: [],
								deferUnselectedContexts: true,
							});
				const completeCatalog = catalogFor(describedActions);
				const parameterSchemas = new Map(
					names.length === 0
						? []
						: describedActions.map((action) => [
								action.name,
								normalizeActionJsonSchema(action),
							]),
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
							: "Complete descriptions and parameter schemas for the requested authorized tools. Other families remain discoverable with names=[]. No tools were enabled or domain work performed.",
					data: {
						readOnlyOperation: true,
						catalog: completeCatalog.parents.map((parent) => ({
							name: parent.name,
							description: parent.source.description,
							...(names.length > 0
								? { parameters: parameterSchemas.get(parent.name) }
								: {}),
							contexts: parent.source.contexts,
							similes: parent.source.similes,
							routingHint: parent.routingHint,
							children: parent.childNames,
							childDefinitions: parent.children.map((child) => ({
								name: child.name,
								description: child.source.description,
								...(names.length > 0
									? { parameters: parameterSchemas.get(child.name) }
									: {}),
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
			onDiscover(selected, names);
			return {
				success: true,
				transcriptVisibility: "internal",
				modelReplyRequired: true,
				text: "Named tools enabled for execution. This receipt contains no parameter definitions; use mode=describe with exact names to inspect them. No domain work or data mutation ran. Continue with requested work.",
				data: {
					readOnlyOperation: true,
					// Operations may share a canonical parent on the native tool wire.
					loadedOperationCount: selected.length,
					loadedTools: selected.map((action) => action.name),
				},
			};
		},
		examples: [],
	};
}

/** Keep explicitly requested operations direct. Represent generated siblings
 * through their complete parent contract, as in initial planner assembly.
 * Callers without requested names retain the legacy expanded surface. Existing
 * definitions and backing execution actions remain unchanged. */
export function appendDiscoveredPlannerTools(
	context: ContextObject,
	current: ToolDefinition[],
	discovered: readonly Action[],
	requestedNames?: readonly string[],
): void {
	const names = new Set(current.map((tool) => tool.name));
	// A discovery load that named its operations expands as canonical families
	// (develop's umbrella contract: an alias rides on its umbrella's pinned
	// discriminator, so no per-alias schema copies); a legacy load without names
	// keeps the flat expansion.
	for (const tool of collectPlannerTools(context, discovered, {
		canonicalFamilies: requestedNames !== undefined,
	})) {
		if (!names.has(tool.name)) {
			current.push(tool);
			names.add(tool.name);
		}
	}
}
