import type { Action, AgentContext, Provider } from "../types/components";
import type { Memory } from "../types/memory";
import type { Content } from "../types/primitives";
import type { State } from "../types/state";
import {
	resolveActionContexts,
	resolveProviderContexts,
} from "./context-catalog";

export const AVAILABLE_CONTEXTS_STATE_KEY = "availableContexts";
export const CONTEXT_ROUTING_METADATA_KEY = "__responseContext";
export const CONTEXT_ROUTING_STATE_KEY = "__contextRouting";

const LIST_SPLIT_RE = /[\n,;]/;

export interface ContextRoutingDecision {
	primaryContext?: AgentContext;
	secondaryContexts?: AgentContext[];
	evidenceTurnIds?: string[];
}

function normalizeContext(value: unknown): AgentContext | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim().toLowerCase();
	return trimmed ? (trimmed as AgentContext) : undefined;
}

function dedupeStringValues(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}
		const lower = trimmed.toLowerCase();
		if (seen.has(lower)) {
			continue;
		}
		seen.add(lower);
		result.push(trimmed);
	}
	return result;
}

function parseDelimitedList(value: unknown): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return dedupeStringValues(
			value.flatMap((entry) =>
				typeof entry === "string"
					? entry.split(LIST_SPLIT_RE)
					: [String(entry)],
			),
		);
	}
	if (typeof value === "string") {
		return dedupeStringValues(value.split(LIST_SPLIT_RE));
	}
	return [];
}

export function parseContextList(value: unknown): AgentContext[] {
	return dedupeStringValues(parseDelimitedList(value))
		.map((context) => normalizeContext(context))
		.filter((context): context is AgentContext => Boolean(context));
}

export function parseContextRoutingMetadata(
	raw: unknown,
): ContextRoutingDecision {
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const value = raw as Record<string, unknown>;
	const primaryContext = normalizeContext(value.primaryContext);
	const secondaryContexts = parseContextList(value.secondaryContexts);
	const evidenceTurnIds = dedupeStringValues(
		parseDelimitedList(value.evidenceTurnIds),
	);

	return {
		primaryContext,
		secondaryContexts,
		evidenceTurnIds,
	};
}

export function getContextRoutingFromState(
	state: State | null | undefined,
): ContextRoutingDecision {
	if (!state?.values) return {};
	return parseContextRoutingMetadata(state.values[CONTEXT_ROUTING_STATE_KEY]);
}

export function getContextRoutingFromMessage(
	message: Memory,
): ContextRoutingDecision {
	const metadata = message.content?.metadata;
	if (!metadata || typeof metadata !== "object") {
		return {};
	}
	return parseContextRoutingMetadata(
		(metadata as Record<string, unknown>)[CONTEXT_ROUTING_METADATA_KEY],
	);
}

export function mergeContextRouting(
	state: State | null | undefined,
	message: Memory,
): ContextRoutingDecision {
	const stateRouting = getContextRoutingFromState(state);
	const messageRouting = getContextRoutingFromMessage(message);

	const mergedSecondary = dedupeStringValues([
		...(stateRouting.secondaryContexts || []),
		...(messageRouting.secondaryContexts || []),
	]) as AgentContext[];

	const mergedEvidenceTurnIds = dedupeStringValues([
		...(stateRouting.evidenceTurnIds || []),
		...(messageRouting.evidenceTurnIds || []),
	]);

	const primaryContext =
		messageRouting.primaryContext || stateRouting.primaryContext || undefined;
	if (primaryContext && !mergedSecondary.includes(primaryContext)) {
		mergedSecondary.unshift(primaryContext);
	}

	return {
		primaryContext,
		secondaryContexts: mergedSecondary,
		evidenceTurnIds: mergedEvidenceTurnIds,
	};
}

export function getActiveRoutingContexts(
	routing: ContextRoutingDecision,
): AgentContext[] {
	const contextSet = new Set<string>();
	if (routing.primaryContext) {
		contextSet.add(routing.primaryContext);
	}
	for (const context of routing.secondaryContexts || []) {
		if (context) {
			contextSet.add(context);
		}
	}
	if (contextSet.size === 0) {
		return [];
	}
	contextSet.add("general");
	return Array.from(contextSet) as AgentContext[];
}

export function shouldIncludeByContext(
	declaredContexts: AgentContext[] | undefined,
	activeContexts: AgentContext[] | undefined,
): boolean {
	if (!declaredContexts || declaredContexts.length === 0) {
		return true;
	}
	if (!activeContexts || activeContexts.length === 0) {
		return true;
	}

	const normalizedActive = new Set(
		(activeContexts || []).map((context) => `${context}`.toLowerCase()),
	);
	return declaredContexts.some((context) =>
		normalizedActive.has(`${context}`.toLowerCase()),
	);
}

export function setContextRoutingMetadata(
	message: Memory,
	routing: ContextRoutingDecision,
): void {
	const existingMetadata =
		message.content && typeof message.content.metadata === "object"
			? (message.content.metadata as Record<string, unknown>)
			: {};

	if (!message.content || typeof message.content !== "object") {
		return;
	}

	message.content = {
		...(message.content as Record<string, unknown>),
		metadata: {
			...existingMetadata,
			[CONTEXT_ROUTING_METADATA_KEY]: routing,
		},
	} as unknown as Content;
}

export function deriveAvailableContexts(
	actions: Action[],
	providers: Provider[],
): AgentContext[] {
	const contextSet = new Set<AgentContext>(["general"]);
	for (const action of actions) {
		for (const context of resolveActionContexts(action)) {
			const normalized = normalizeContext(context);
			if (normalized) {
				contextSet.add(normalized);
			}
		}
	}
	for (const provider of providers) {
		for (const context of resolveProviderContexts(provider)) {
			const normalized = normalizeContext(context);
			if (normalized) {
				contextSet.add(normalized);
			}
		}
	}
	return Array.from(contextSet).sort((a, b) => `${a}`.localeCompare(`${b}`));
}

export function attachAvailableContexts(
	state: State,
	runtime: { actions: Action[]; providers: Provider[] },
): State {
	const availableContexts = deriveAvailableContexts(
		runtime.actions,
		runtime.providers,
	);
	return {
		...state,
		values: {
			...(state.values || {}),
			[AVAILABLE_CONTEXTS_STATE_KEY]: availableContexts.join(", "),
		},
	};
}
