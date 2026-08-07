/**
 * Per-action model routing — strategy registry.
 *
 * Resolves an action's model class independently from the planner model, so an
 * action can run on a small or local model while planning uses a larger model.
 *
 * Design constraints (AGENTS.md):
 *   - No runtime type-branching mess: each `ActionModelClass` is a strategy
 *     entry in {@link ACTION_MODEL_STRATEGIES}. New classes are additions to
 *     that table, not new `if/else` branches.
 *   - Strong typing: no `any`, no unsafe casts at the call sites.
 *   - When `action.modelClass` is absent, the resolver
 *     returns `null` and the runtime falls through to its existing behavior.
 *
 * Fallback chain (ascending cost / capability):
 *   `LOCAL → TEXT_SMALL → TEXT_LARGE`
 *
 * Failure semantics:
 *   - If the preferred model handler throws, escalate one step up the chain
 *     and retry. The last step in the chain is terminal — its error is
 *     re-raised.
 *   - If the call returns a `confidence` field below the strategy's threshold,
 *     escalate one step up and retry. This is opt-in: returns without a
 *     `confidence` field are never re-evaluated.
 */

import { LOCAL_MODEL_PROVIDERS } from "../constants/secrets";
import type { ActionModelClass } from "../types/components";
import type { ModelHandler, ModelRegistrationMetadata } from "../types/model";
import { ModelType } from "../types/model";

/**
 * Minimal capability view of a model registration, used by routing predicates.
 *
 * Routing decisions are driven by provider-declared capability metadata
 * ({@link ModelRegistrationMetadata}) first, with the provider *name* available
 * only as an explicitly-tested fallback for registrations that have not yet
 * adopted the capability flags. Accepting this view (rather than a bare name
 * string) is what lets {@link isLocalHandler} consult the declared contract
 * instead of duck-typing the provider name.
 */
export interface ModelCapabilityView {
	readonly provider: string;
	readonly metadata?: ModelRegistrationMetadata;
}

/**
 * One step in a fallback chain.
 *
 * `modelType` is the model registration key to look up (one of `ModelType.*`).
 *
 * `providerFilter` is an optional predicate over the registered provider's
 * capability view. For the `LOCAL` strategy this restricts resolution to
 * local-provider registrations (Ollama, LM Studio, MLX, llama.cpp, etc.) so
 * that a `LOCAL` request never silently calls a cloud provider that also
 * happens to be registered for `TEXT_SMALL`.
 */
export interface ActionModelRoutingStep {
	readonly modelType: string;
	/**
	 * Optional predicate over a candidate registration. Receives the full
	 * capability view ({@link ModelCapabilityView}) so the filter can consult
	 * provider-declared metadata (e.g. `metadata.local`) rather than substring-
	 * matching the provider name. For the `LOCAL` strategy this is
	 * {@link isLocalHandler}, which prefers the declared `local` capability and
	 * falls back to the {@link isLocalProvider} name heuristic only for providers
	 * that have not adopted the flag.
	 */
	readonly providerFilter?: (candidate: ModelCapabilityView) => boolean;
}

/**
 * Strategy entry for one {@link ActionModelClass}.
 *
 * `chain` is ordered cheapest-first / most-preferred-first. The runtime tries
 * each step in order, escalating to the next on error or low confidence.
 *
 * `confidenceThreshold` is the minimum confidence below which the call is
 * considered low-confidence and the runtime escalates. `undefined` disables
 * confidence-based escalation for this class.
 */
export interface ActionModelRoutingStrategy {
	readonly chain: readonly ActionModelRoutingStep[];
	readonly confidenceThreshold?: number;
}

/**
 * Name-only heuristic: does this provider *name* look like a local-inference
 * provider?
 *
 * @deprecated for classification decisions. Prefer {@link isLocalHandler},
 * which consumes the provider-declared `metadata.local` capability and only
 * falls back to this name heuristic for registrations that have not adopted the
 * flag yet. This function is retained as that explicitly-tested fallback (and
 * for the runtime streaming gate, which keys off the name for the
 * `eliza-router` special case). It is intentionally narrow.
 *
 * Sourced from {@link LOCAL_MODEL_PROVIDERS} (the single source of truth for
 * the canonical local providers list, also used by the secrets and pricing
 * layers) plus a substring pass for common local-OpenAI-compatible servers
 * (LM Studio, MLX, llama.cpp) so plugins registered under names like
 * `"lm-studio"` or `"mlx-lm"` still resolve when they omit the capability flag.
 */
export function isLocalProvider(provider: string): boolean {
	const normalized = provider.toLowerCase();
	if ((LOCAL_MODEL_PROVIDERS as readonly string[]).includes(normalized)) {
		return true;
	}
	// Heuristic for plugins not declaring `metadata.local` yet. The list above
	// is the authoritative gate when present; this only opens the door for
	// well-known local-server families. Keep narrow.
	return (
		normalized.includes("ollama") ||
		normalized.includes("lm-studio") ||
		normalized.includes("lmstudio") ||
		normalized.includes("mlx") ||
		normalized.includes("llama.cpp") ||
		normalized.includes("llamacpp") ||
		normalized.includes("eliza-local-inference") ||
		normalized.includes("eliza-device-bridge") ||
		normalized.includes("capacitor-llama") ||
		normalized.includes("eliza-aosp-llama") ||
		normalized === "local"
	);
}

/**
 * Predicate: is this registration a local-inference target?
 *
 * Capability-first classification. Precedence:
 *   1. If the provider declared `metadata.local` explicitly (`true`/`false`),
 *      that verdict wins — the owner metadata is authoritative.
 *   2. Otherwise fall back to the {@link isLocalProvider} name heuristic for
 *      providers that have not adopted the capability flag yet.
 *
 * This is the predicate the `LOCAL` routing strategy uses so a `LOCAL` request
 * never silently resolves to a cloud provider, and so providers can opt out of
 * the name heuristic (or opt in without matching a name family) by declaring
 * the flag.
 */
export function isLocalHandler(candidate: ModelCapabilityView): boolean {
	const declared = candidate.metadata?.local;
	if (typeof declared === "boolean") {
		return declared;
	}
	return isLocalProvider(candidate.provider);
}

/**
 * The strategy registry. Keyed by {@link ActionModelClass}.
 *
 * To add a new class, add it to the {@link ActionModelClass} union in
 * `types/components.ts` and add its entry here. Do not add `if (modelClass === ...)`
 * branches at call sites — extend this table instead.
 */
export const ACTION_MODEL_STRATEGIES: Readonly<
	Record<ActionModelClass, ActionModelRoutingStrategy>
> = {
	LOCAL: {
		chain: [
			{ modelType: ModelType.TEXT_SMALL, providerFilter: isLocalHandler },
			{ modelType: ModelType.TEXT_SMALL },
			{ modelType: ModelType.TEXT_LARGE },
		],
	},
	TEXT_SMALL: {
		chain: [
			{ modelType: ModelType.TEXT_SMALL },
			{ modelType: ModelType.TEXT_LARGE },
		],
	},
	TEXT_LARGE: {
		chain: [{ modelType: ModelType.TEXT_LARGE }],
	},
};

/**
 * The model classes that this routing system can override. Text-generation
 * model types only. Embeddings / image / audio / tokenizer calls flow through
 * the runtime's default resolution unchanged because they don't have a
 * meaningful small/large/local trichotomy at the action level.
 */
export const ROUTABLE_TEXT_MODEL_TYPES: ReadonlySet<string> = new Set([
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_REASONING_SMALL,
	ModelType.TEXT_REASONING_LARGE,
	ModelType.TEXT_COMPLETION,
]);

/**
 * Look up the routing strategy for an action's `modelClass`.
 *
 * Returns `undefined` when:
 *   - `modelClass` is undefined (back-compat path).
 *   - `modelClass` is a string that is not a registered key (forward-compat —
 *     the runtime treats unknown classes as "no preference" rather than
 *     throwing, so a plugin with a newer `MEDIUM` action descriptor running
 *     against an older runtime degrades to default behavior instead of
 *     crashing).
 */
export function getActionModelStrategy(
	modelClass: ActionModelClass | undefined,
): ActionModelRoutingStrategy | undefined {
	if (!modelClass) {
		return undefined;
	}
	return ACTION_MODEL_STRATEGIES[modelClass];
}

/**
 * Should the runtime re-route this `useModel` call based on the action's
 * `modelClass`? Reroute only when:
 *   - The action has a `modelClass`.
 *   - The requested model type is in {@link ROUTABLE_TEXT_MODEL_TYPES}.
 *
 * Returns the strategy if rerouting applies; otherwise `undefined`.
 */
export function maybeReroute(
	modelClass: ActionModelClass | undefined,
	requestedModelType: string,
): ActionModelRoutingStrategy | undefined {
	if (!ROUTABLE_TEXT_MODEL_TYPES.has(requestedModelType)) {
		return undefined;
	}
	return getActionModelStrategy(modelClass);
}

/**
 * Result of resolving a single step against a runtime's model registry.
 *
 * `handler` is the registered {@link ModelHandler.handler}. `modelType` is the
 * key the handler was found under (after the providerFilter narrowing).
 * `provider` is the registered provider name — useful for telemetry and for
 * surfacing in the trajectory recorder.
 */
export interface ResolvedActionModel {
	readonly handler: ModelHandler["handler"];
	readonly modelType: string;
	readonly provider: string;
}

/**
 * Locate a handler matching one routing step against an `(modelType → handlers)`
 * registry. Honors `providerFilter` if set; otherwise picks the highest-priority
 * registered handler for `modelType`.
 *
 * Caller-supplied `lookup` is the runtime's `models` map (or an equivalent
 * read-only view). This indirection lets the resolver be unit-tested without
 * a full {@link AgentRuntime} instance.
 */
export function resolveStep(
	step: ActionModelRoutingStep,
	lookup: (modelType: string) => readonly ModelHandler[] | undefined,
): ResolvedActionModel | undefined {
	const handlers = lookup(step.modelType);
	if (!handlers || handlers.length === 0) {
		return undefined;
	}
	const providerFilter = step.providerFilter;
	const match = providerFilter
		? handlers.find((h) => providerFilter(h))
		: handlers[0];
	if (!match) {
		return undefined;
	}
	return {
		handler: match.handler,
		modelType: step.modelType,
		provider: match.provider,
	};
}

/**
 * Resolve the full chain into an ordered list of usable handlers. Steps with
 * no matching registration are skipped silently — the chain is best-effort and
 * the caller treats an empty result as "no local handler available, fall back
 * to default resolution".
 */
export function resolveChain(
	strategy: ActionModelRoutingStrategy,
	lookup: (modelType: string) => readonly ModelHandler[] | undefined,
): ResolvedActionModel[] {
	const resolved: ResolvedActionModel[] = [];
	const seen = new Set<string>();
	for (const step of strategy.chain) {
		const handlers = lookup(step.modelType);
		if (!handlers || handlers.length === 0) {
			continue;
		}
		for (const handler of handlers) {
			if (step.providerFilter && !step.providerFilter(handler)) {
				continue;
			}
			const key = `${step.modelType}:${handler.provider}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			resolved.push({
				handler: handler.handler,
				modelType: step.modelType,
				provider: handler.provider,
			});
			break;
		}
	}
	return resolved;
}

/**
 * Should this result trigger escalation to the next step in the chain?
 *
 * Today the only signal is an optional `confidence` field on the result. When
 * the result is a plain string or doesn't expose `confidence`, the call is
 * accepted as-is — i.e., the absence of a confidence signal is never treated
 * as low confidence (false negatives would cause unnecessary escalation).
 */
export function isLowConfidence(
	result: unknown,
	threshold: number | undefined,
): boolean {
	if (threshold === undefined) {
		return false;
	}
	if (!result || typeof result !== "object") {
		return false;
	}
	const conf = (result as { confidence?: unknown }).confidence;
	if (typeof conf !== "number") {
		return false;
	}
	return conf < threshold;
}

/**
 * Execute the resolved chain with ascending-fallback semantics.
 *
 * Steps are attempted in order. On error or low-confidence result, the next
 * step is tried. The first acceptable result is returned. If every step fails,
 * the last error is re-raised (preserves the stack from the terminal handler
 * rather than the first one).
 *
 * `invoke` is the runtime's per-call invoker. It receives the resolved handler
 * along with the model-type key it was found under (so the runtime can log /
 * record the actual model that ran) and returns the model result. This
 * indirection lets the runtime keep its existing model-settings merge, logging,
 * and trajectory hooks identical between routed and non-routed calls.
 */
export async function executeChainWithFallback<TResult>(
	chain: readonly ResolvedActionModel[],
	threshold: number | undefined,
	invoke: (resolved: ResolvedActionModel) => Promise<TResult>,
): Promise<TResult> {
	if (chain.length === 0) {
		throw new Error(
			"executeChainWithFallback: chain is empty — no handlers resolved",
		);
	}
	let lastError: unknown;
	for (let i = 0; i < chain.length; i++) {
		const resolved = chain[i];
		if (!resolved) {
			continue;
		}
		try {
			const result = await invoke(resolved);
			const isLast = i === chain.length - 1;
			if (!isLast && isLowConfidence(result, threshold)) {
				// Don't return yet — escalate.
				lastError = new Error(
					`Low-confidence result from ${resolved.modelType} (provider=${resolved.provider}); escalating`,
				);
				continue;
			}
			return result;
		} catch (err) {
			// error-policy:J4 Each chain entry is an explicitly configured model
			// failover; the final failure still propagates after all entries are tried.
			lastError = err;
			// Continue to the next step in the chain.
		}
	}
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error(
		`executeChainWithFallback: all ${chain.length} step(s) failed without a thrown error`,
	);
}
