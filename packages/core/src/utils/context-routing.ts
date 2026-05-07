import type { Action, AgentContext, Provider } from "../types/components";
import type { Memory } from "../types/memory";
import type { Content } from "../types/primitives";
import type { State } from "../types/state";
import {
	resolveActionContexts,
	resolveProviderContexts,
} from "./context-catalog";
import { normalizeUserMessageText } from "./message-text";

export const AVAILABLE_CONTEXTS_STATE_KEY = "availableContexts";
export const CONTEXT_CAPABILITIES_STATE_KEY = "__contextCapabilities";
export const CONTEXT_ROUTING_METADATA_KEY = "__responseContext";
export const CONTEXT_ROUTING_STATE_KEY = "__contextRouting";

const LIST_SPLIT_RE = /[\n,;]/;

export interface ContextRoutingDecision {
	primaryContext?: AgentContext;
	secondaryContexts?: AgentContext[];
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

export function isPageScopedRoutingContext(context: unknown): boolean {
	if (typeof context !== "string") return false;
	const normalized = context.trim().toLowerCase();
	return normalized === "page" || normalized.startsWith("page-");
}

export function normalizeRoutingContexts(
	contexts: readonly unknown[] | undefined,
): AgentContext[] {
	return dedupeStringValues(
		(contexts ?? []).flatMap((context) =>
			typeof context === "string" ? context.split(LIST_SPLIT_RE) : [],
		),
	)
		.map((context) => normalizeContext(context))
		.filter((context): context is AgentContext => Boolean(context));
}

export function getExplicitRoutingContexts(
	activeContexts: readonly AgentContext[] | undefined,
): AgentContext[] {
	return normalizeRoutingContexts(activeContexts).filter(
		(context) => context !== "general" && !isPageScopedRoutingContext(context),
	);
}

export function routingContextsOverlap(
	left: readonly AgentContext[] | undefined,
	right: readonly AgentContext[] | undefined,
): boolean {
	const normalizedRight = new Set(
		normalizeRoutingContexts(right).map((context) =>
			`${context}`.toLowerCase(),
		),
	);
	if (normalizedRight.size === 0) {
		return false;
	}
	return normalizeRoutingContexts(left).some((context) =>
		normalizedRight.has(`${context}`.toLowerCase()),
	);
}

export function shouldSurfaceContextCapabilities(
	declaredContexts: readonly AgentContext[] | undefined,
	activeContexts: readonly AgentContext[] | undefined,
): boolean {
	if (
		normalizeRoutingContexts(activeContexts).some(isPageScopedRoutingContext)
	) {
		return false;
	}
	const explicitContexts = getExplicitRoutingContexts(activeContexts);
	return (
		explicitContexts.length > 0 &&
		routingContextsOverlap(declaredContexts, explicitContexts)
	);
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

	return {
		primaryContext,
		secondaryContexts,
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

	const primaryContext =
		messageRouting.primaryContext || stateRouting.primaryContext || undefined;
	if (primaryContext && !mergedSecondary.includes(primaryContext)) {
		mergedSecondary.unshift(primaryContext);
	}

	return {
		primaryContext,
		secondaryContexts: mergedSecondary,
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

export function getActiveRoutingContextsForTurn(
	state: State | null | undefined,
	message: Memory,
): AgentContext[] {
	return getActiveRoutingContexts(mergeContextRouting(state, message));
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

type ContextSignal = {
	context: AgentContext;
	patterns: RegExp[];
};

const CONTEXT_SIGNALS: ContextSignal[] = [
	{
		context: "code",
		patterns: [
			/\b(repo|repository|codebase|branch|commit|pull request|pr|diff|workspace|file|directory)\b/u,
			/\b(code|coding|implement|debug|fix|refactor|patch|test|typecheck|lint|build|component|api|server|client)\b/u,
			/\b(task agents?|sub-?agents?|coding agents?|codex|claude code|spawn an? agent|agent running|what are you working on)\b/u,
		],
	},
	{
		context: "automation",
		patterns: [
			/\b(schedule|remind|reminder|cron|workflow|automate|automation|run this|execute|deploy|release|monitor)\b/u,
			/\b(task agents?|sub-?agents?|agent running|pause that|resume that|stop that|continue that|what are you working on)\b/u,
		],
	},
	{
		context: "knowledge",
		patterns: [
			/\b(uploaded|document|file|pdf|knowledge|remember|recall|search|lookup|find|summari[sz]e|analy[sz]e|research)\b/u,
			/\b(what is|what was|where is|tell me about|explain)\b/u,
		],
	},
	{
		context: "browser",
		patterns: [
			/\b(browser|browse|website|web page|url|click|type into|screenshot|navigate|extract page)\b/u,
		],
	},
	{
		context: "apps",
		patterns: [
			/\b(apps?|catalog app|launch app|relaunch app|app session|app viewer)\b/u,
		],
	},
	{
		context: "plugins",
		patterns: [
			/\b(plugins?|install plugin|eject plugin|plugin registry|plugin health|core status)\b/u,
		],
	},
	{
		context: "connectors",
		patterns: [
			/\b(connectors?|telegram|discord|signal|whatsapp|slack|oauth|webhook)\b/u,
		],
	},
	{
		context: "phone",
		patterns: [
			/\b(phone|call|sms|text message|dialer|voicemail|contact|vcard)\b/u,
		],
	},
	{
		context: "lifeops",
		patterns: [
			/\b(lifeops|life ops|reminder|goal|habit|inbox|calendar|sleep|screen time|subscription|travel)\b/u,
		],
	},
	{
		context: "character",
		patterns: [
			/\b(character|persona|personality|bio|style rules|message examples|voice|identity)\b/u,
		],
	},
	{
		context: "media",
		patterns: [
			/\b(image|picture|photo|video|audio|voice|transcribe|screenshot|draw|generate an image)\b/u,
		],
	},
	{
		context: "wallet",
		patterns: [
			/\b(wallet|token|swap|bridge|stake|unstake|balance|portfolio|transaction|sign message|contract)\b/u,
		],
	},
	{
		context: "social",
		patterns: [
			/\b(message|dm|email|inbox|contact|relationship|follow up|calendar|meeting|call|send .* to)\b/u,
		],
	},
	{
		context: "system",
		patterns: [
			/\b(settings?|configure|configuration|plugin|secret|api key|model provider|oauth|login|auth)\b/u,
		],
	},
	{
		context: "settings",
		patterns: [
			/\b(settings?|model provider|feature toggle|auto training|identity settings|permissions|rpc provider)\b/u,
		],
	},
];

export function inferContextRoutingFromText(
	text: string | null | undefined,
): ContextRoutingDecision {
	const normalized = normalizeUserMessageText({
		content: { text: text ?? "" },
	} as Pick<Memory, "content">);
	if (!normalized) {
		return { primaryContext: "general", secondaryContexts: [] };
	}

	const scored = CONTEXT_SIGNALS.map((signal) => ({
		context: signal.context,
		score: signal.patterns.reduce(
			(score, pattern) => score + (pattern.test(normalized) ? 1 : 0),
			0,
		),
	}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);

	if (scored.length === 0) {
		return { primaryContext: "general", secondaryContexts: [] };
	}

	const primaryContext = scored[0].context;
	const secondaryContexts = scored
		.slice(1)
		.filter((entry) => entry.score >= Math.max(1, scored[0].score - 1))
		.map((entry) => entry.context);

	return { primaryContext, secondaryContexts };
}

export function inferContextRoutingFromMessage(
	message: Pick<Memory, "content">,
): ContextRoutingDecision {
	return inferContextRoutingFromText(
		typeof message.content === "string"
			? message.content
			: typeof message.content?.text === "string"
				? message.content.text
				: "",
	);
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
			...state.values,
			[AVAILABLE_CONTEXTS_STATE_KEY]: availableContexts.join(", "),
		},
	};
}
