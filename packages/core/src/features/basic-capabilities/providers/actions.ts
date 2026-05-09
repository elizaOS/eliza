import { formatActionNames, formatActions } from "../../../actions.ts";
import { evaluateConnectorAccountPolicies } from "../../../connectors/account-manager.ts";
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	Action,
	AgentContext,
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import {
	resolveActionContexts,
	resolveProviderContexts,
} from "../../../utils/context-catalog";
import {
	CONTEXT_CAPABILITIES_STATE_KEY,
	getActiveRoutingContextsForTurn,
	getExplicitRoutingContexts,
	isPageScopedRoutingContext,
	routingContextsOverlap,
	shouldIncludeByContext,
	shouldSurfaceContextCapabilities,
} from "../../../utils/context-routing.ts";
import { buildDeterministicSeed } from "../../../utils/deterministic";
import { compressPromptDescription } from "../../../utils/prompt-compression.ts";
import {
	looksLikeNonActionableChatter,
	looksLikeRelationshipFollowUpReminder,
} from "./non-actionable-chatter.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ACTIONS");
const GENERIC_CHAT_ACTIONS = new Set(["REPLY", "IGNORE", "NONE"]);
const RELATIONSHIP_FOLLOW_UP_ACTIONS = new Set([
	"RELATIONSHIP",
	"REPLY",
	"IGNORE",
	"NONE",
]);
const GENERAL_CONTEXT = "general";
const MAX_GROUPED_CAPABILITY_ACTIONS = 8;
const MAX_GROUPED_CAPABILITY_PROVIDERS = 4;

type GroupedAction = Action & {
	actionGroup?: {
		contexts?: string[];
	};
};

type ContextCapabilityItem = {
	name: string;
	description: string;
	contexts: string[];
	dynamic?: boolean;
};

type ContextCapabilityGroup = {
	action: string;
	contexts: string[];
	actions: ContextCapabilityItem[];
	providers: ContextCapabilityItem[];
};

type ContextCapabilityMetadata = {
	activeContexts: string[];
	explicitContexts: string[];
	groups: ContextCapabilityGroup[];
};

function normalizeContextList(
	contexts: readonly string[] | undefined,
): string[] {
	return [...new Set((contexts ?? []).map((context) => context.toLowerCase()))];
}

function getActionGroupContexts(action: Action): string[] {
	const contexts = (action as GroupedAction).actionGroup?.contexts;
	return normalizeContextList(contexts).filter(
		(context) =>
			context !== GENERAL_CONTEXT && !isPageScopedRoutingContext(context),
	);
}

function isActionGroup(action: Action): boolean {
	return getActionGroupContexts(action).length > 0;
}

function collapseGroupedActionsForMainChat(
	actions: Action[],
	activeContexts: string[],
): Action[] {
	if (activeContexts.some(isPageScopedRoutingContext)) {
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

function renderCompressedDescription(item: {
	description?: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
}): string {
	return (
		item.descriptionCompressed ??
		item.compressedDescription ??
		(item.description ? compressPromptDescription(item.description) : "")
	);
}

function actionCapabilityItem(action: Action): ContextCapabilityItem {
	return {
		name: action.name,
		description:
			renderCompressedDescription(action) || "No description available",
		contexts: normalizeContextList(resolveActionContexts(action)),
	};
}

function providerCapabilityItem(provider: Provider): ContextCapabilityItem {
	return {
		name: provider.name,
		description:
			renderCompressedDescription(provider) || "No description available",
		contexts: normalizeContextList(resolveProviderContexts(provider)),
		dynamic: provider.dynamic === true,
	};
}

function formatCapabilityItems(
	label: string,
	items: ContextCapabilityItem[],
	limit: number,
): string | null {
	if (items.length === 0) {
		return null;
	}

	const visibleItems = items.slice(0, limit);
	const suffix =
		items.length > visibleItems.length
			? `; +${items.length - visibleItems.length} more`
			: "";
	return `${label}[${items.length}]: ${visibleItems
		.map((item) => `${item.name} - ${item.description}`)
		.join("; ")}${suffix}`;
}

function expandActionDescription(
	action: Action,
	group: ContextCapabilityGroup,
): string {
	const base =
		renderCompressedDescription(action) || "No description available";
	const sections = [
		formatCapabilityItems(
			"subactions",
			group.actions,
			MAX_GROUPED_CAPABILITY_ACTIONS,
		),
		formatCapabilityItems(
			"providers",
			group.providers,
			MAX_GROUPED_CAPABILITY_PROVIDERS,
		),
	].filter((section): section is string => Boolean(section));

	return sections.length > 0 ? `${base} ${sections.join(" ")}` : base;
}

function buildContextCapabilityGroups(
	visibleActions: Action[],
	groupedActions: Action[],
	providers: Provider[],
	activeContexts: AgentContext[],
): ContextCapabilityMetadata {
	const explicitContexts = getExplicitRoutingContexts(activeContexts);
	const metadata: ContextCapabilityMetadata = {
		activeContexts: normalizeContextList(activeContexts),
		explicitContexts: normalizeContextList(explicitContexts),
		groups: [],
	};

	if (activeContexts.some(isPageScopedRoutingContext)) {
		return metadata;
	}

	for (const action of groupedActions) {
		const groupContexts = getActionGroupContexts(action) as AgentContext[];
		if (!shouldSurfaceContextCapabilities(groupContexts, activeContexts)) {
			continue;
		}

		const childActions = visibleActions
			.filter((candidate) => candidate.name !== action.name)
			.filter((candidate) => !isActionGroup(candidate))
			.filter((candidate) =>
				routingContextsOverlap(resolveActionContexts(candidate), groupContexts),
			)
			.map(actionCapabilityItem)
			.sort((left, right) => left.name.localeCompare(right.name));

		const dynamicProviders = providers
			.filter((provider) => provider.dynamic === true)
			.filter((provider) =>
				shouldIncludeByContext(
					resolveProviderContexts(provider),
					activeContexts,
				),
			)
			.filter((provider) =>
				routingContextsOverlap(
					resolveProviderContexts(provider),
					groupContexts,
				),
			)
			.map(providerCapabilityItem)
			.sort((left, right) => left.name.localeCompare(right.name));

		if (childActions.length === 0 && dynamicProviders.length === 0) {
			continue;
		}

		metadata.groups.push({
			action: action.name,
			contexts: groupContexts,
			actions: childActions,
			providers: dynamicProviders,
		});
	}

	return metadata;
}

function expandGroupedActionsForActiveContext(
	actionsData: Action[],
	visibleActions: Action[],
	providers: Provider[],
	activeContexts: AgentContext[],
): { actionsData: Action[]; contextCapabilities: ContextCapabilityMetadata } {
	const contextCapabilities = buildContextCapabilityGroups(
		visibleActions,
		actionsData.filter(isActionGroup),
		providers,
		activeContexts,
	);
	if (contextCapabilities.groups.length === 0) {
		return { actionsData, contextCapabilities };
	}

	const groupsByActionName = new Map(
		contextCapabilities.groups.map((group) => [group.action, group]),
	);
	return {
		contextCapabilities,
		actionsData: actionsData.map((action) => {
			const group = groupsByActionName.get(action.name);
			if (!group) {
				return action;
			}
			return {
				...action,
				descriptionCompressed: expandActionDescription(action, group),
			};
		}),
	};
}

function formatContextCapabilities(
	metadata: ContextCapabilityMetadata,
): string {
	if (metadata.groups.length === 0) {
		return "";
	}

	const lines = [
		"# Context Capabilities",
		`active_contexts[${metadata.activeContexts.length}]: ${metadata.activeContexts.join(", ")}`,
		`context_groups[${metadata.groups.length}]:`,
	];

	for (const group of metadata.groups) {
		lines.push(`- ${group.action}: contexts=${group.contexts.join("|")}`);
		const subactions = formatCapabilityItems(
			"subactions",
			group.actions,
			MAX_GROUPED_CAPABILITY_ACTIONS,
		);
		if (subactions) {
			lines.push(`  ${subactions}`);
		}
		const providers = formatCapabilityItems(
			"providers",
			group.providers,
			MAX_GROUPED_CAPABILITY_PROVIDERS,
		);
		if (providers) {
			lines.push(`  ${providers}`);
		}
	}

	return lines.join("\n");
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
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: true,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

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
			if (!result) {
				return null;
			}
			const accountPolicy = await evaluateConnectorAccountPolicies(
				runtime,
				action,
				{ message },
			);
			return accountPolicy.allowed ? action : null;
		});

		const resolvedActions = await Promise.all(actionPromises);

		const nonActionableChatter = looksLikeNonActionableChatter(message);
		const relationshipFollowUpReminder =
			looksLikeRelationshipFollowUpReminder(message);
		const availableActions = resolvedActions.filter(Boolean) as Action[];
		const hasRelationshipAction = availableActions.some(
			(action) => action.name === "RELATIONSHIP",
		);
		const visibleActions = availableActions.filter((action) => {
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
		});
		const collapsedActions = collapseGroupedActionsForMainChat(
			visibleActions,
			activeContexts,
		);
		const { actionsData, contextCapabilities } =
			expandGroupedActionsForActiveContext(
				collapsedActions,
				visibleActions,
				runtime.providers ?? [],
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
			actionsData.length > 0 ? formatActions(actionsData, actionSeed) : "";
		const contextCapabilitiesText =
			formatContextCapabilities(contextCapabilities);

		const values = {
			actionNames,
			actionsWithDescriptions,
			contextCapabilities: contextCapabilitiesText,
			[CONTEXT_CAPABILITIES_STATE_KEY]: contextCapabilitiesText,
		};

		// Combine all text sections - now including actionsWithDescriptions
		const text = [actionNames, actionsWithDescriptions, contextCapabilitiesText]
			.filter(Boolean)
			.join("\n\n");

		return {
			data: {
				actionsData,
				contextCapabilities,
			},
			values,
			text,
		};
	},
};
