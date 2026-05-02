import { formatActionNames, formatActions } from "../../../actions.ts";
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	Action,
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import { resolveActionContexts } from "../../../utils/context-catalog";
import {
	getActiveRoutingContextsForTurn,
	shouldIncludeByContext,
} from "../../../utils/context-routing.ts";
import { buildDeterministicSeed } from "../../../utils/deterministic";
import { addHeader } from "../../../utils.ts";
import {
	looksLikeNonActionableChatter,
	looksLikeRelationshipFollowUpReminder,
} from "./non-actionable-chatter.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ACTIONS");
const GENERIC_CHAT_ACTIONS = new Set(["REPLY", "IGNORE", "NONE"]);
const RELATIONSHIP_FOLLOW_UP_ACTIONS = new Set([
	"OWNER_RELATIONSHIP",
	"REPLY",
	"IGNORE",
	"NONE",
]);
const GENERAL_CONTEXT = "general";
const PAGE_CONTEXT = "page";

type GroupedAction = Action & {
	actionGroup?: {
		contexts?: string[];
	};
};

function isPageScopedContext(context: unknown): boolean {
	if (typeof context !== "string") return false;
	const normalized = context.toLowerCase();
	return normalized === PAGE_CONTEXT || normalized.startsWith("page-");
}

function normalizeContextList(
	contexts: readonly string[] | undefined,
): string[] {
	return [...new Set((contexts ?? []).map((context) => context.toLowerCase()))];
}

function getActionGroupContexts(action: Action): string[] {
	const contexts = (action as GroupedAction).actionGroup?.contexts;
	return normalizeContextList(contexts).filter(
		(context) => context !== GENERAL_CONTEXT && !isPageScopedContext(context),
	);
}

function isActionGroup(action: Action): boolean {
	return getActionGroupContexts(action).length > 0;
}

function collapseGroupedActionsForMainChat(
	actions: Action[],
	activeContexts: string[],
): Action[] {
	if (activeContexts.some(isPageScopedContext)) {
		return actions.filter((action) => !isActionGroup(action));
	}

	const groupedContexts = new Set<string>();
	for (const action of actions) {
		for (const context of getActionGroupContexts(action)) {
			groupedContexts.add(context);
		}
	}
	if (groupedContexts.size === 0) {
		return actions;
	}

	return actions.filter((action) => {
		if (isActionGroup(action)) {
			return true;
		}
		return !normalizeContextList(resolveActionContexts(action)).some(
			(context) => groupedContexts.has(context),
		);
	});
}

/**
 * A provider object that fetches possible response actions based on the provided runtime, message, and state.
 * @type {Provider}
 * @property {string} name - The name of the provider ("ACTIONS").
 * @property {string} description - The description of the provider ("Possible response actions").
 * @property {number} position - The position of the provider (-1).
 * @property {Function} get - Asynchronous function that retrieves actions that validate for the given message.
 * @param {IAgentRuntime} runtime - The runtime object.
 * @param {Memory} message - The message memory.
 * @param {State} state - The state object.
 * @returns {Object} An object containing the actions data, values, and combined text sections.
 */
/**
 * Provider for ACTIONS
 *
 * @typedef {import('./Provider').Provider} Provider
 * @typedef {import('./Runtime').IAgentRuntime} IAgentRuntime
 * @typedef {import('./Memory').Memory} Memory
 * @typedef {import('./State').State} State
 * @typedef {import('./Action').Action} Action
 *
 * @type {Provider}
 * @property {string} name - The name of the provider
 * @property {string} description - Description of the provider
 * @property {number} position - The position of the provider
 * @property {Function} get - Asynchronous function to get actions that validate for a given message
 *
 * @param {IAgentRuntime} runtime - The agent runtime
 * @param {Memory} message - The message memory
 * @param {State} state - The state of the agent
 * @returns {Object} Object containing data, values, and text related to actions
 */
export const actionsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	position: spec.position ?? -1,
	get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
		const activeContexts = getActiveRoutingContextsForTurn(state, message);

		// Get actions that validate for this message
		const actionPromises = runtime.actions.map(async (action: Action) => {
			if (
				!shouldIncludeByContext(resolveActionContexts(action), activeContexts)
			) {
				return null;
			}

			const result = await action.validate(runtime, message, state);
			if (result) {
				return action;
			}
			return null;
		});

		const resolvedActions = await Promise.all(actionPromises);

		const nonActionableChatter = looksLikeNonActionableChatter(message);
		const relationshipFollowUpReminder =
			looksLikeRelationshipFollowUpReminder(message);
		const availableActions = resolvedActions.filter(Boolean) as Action[];
		const hasRelationshipAction = availableActions.some(
			(action) => action.name === "OWNER_RELATIONSHIP",
		);
		const actionsData = collapseGroupedActionsForMainChat(
			availableActions.filter((action) => {
				if (nonActionableChatter && !GENERIC_CHAT_ACTIONS.has(action.name)) {
					return false;
				}
				if (
					relationshipFollowUpReminder &&
					hasRelationshipAction &&
					!RELATIONSHIP_FOLLOW_UP_ACTIONS.has(action.name)
				) {
					return false;
				}
				return true;
			}),
			activeContexts,
		);
		const actionSeed = buildDeterministicSeed(
			runtime.agentId,
			message.roomId,
			"ACTIONS",
		);

		// Format action-related texts
		const actionNames = `Possible response actions: ${formatActionNames(actionsData, actionSeed)}`;

		const actionsWithDescriptions =
			actionsData.length > 0
				? addHeader(
						"# Available Actions",
						formatActions(actionsData, actionSeed),
					)
				: "";

		const values = {
			actionNames,
			actionsWithDescriptions,
		};

		// Combine all text sections - now including actionsWithDescriptions
		const text = [actionNames, actionsWithDescriptions]
			.filter(Boolean)
			.join("\n\n");

		return {
			data: {
				actionsData,
			},
			values,
			text,
		};
	},
};
