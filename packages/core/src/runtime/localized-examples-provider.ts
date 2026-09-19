/**
 * Runtime-level hook a host plugin (e.g. `@elizaos/plugin-personal-assistant`) registers so
 * the planner can swap English `ActionExample` pairs for localized variants
 * at catalog-build time without core needing to import plugin-side symbols.
 *
 * The provider receives a synchronously-known recent user message and is
 * allowed to be async — it commonly reads `OwnerFactStore.locale` (which is
 * cache-backed and therefore async). The planner awaits the provider once
 * per turn before calling `buildActionCatalog`.
 *
 * Cycle-avoidance: core defines the slot, plugins fill it. Core never
 * imports `app-lifeops` types.
 *
 * Registration is a `WeakMap` keyed by `IAgentRuntime` so the lifetime tracks
 * the runtime and we don't leak across tests — same shape as `SendPolicy`.
 */

import type { ActionExample } from "../types/components";
import type { IAgentRuntime } from "../types/runtime";
/**
 * Localized `[user, agent]` pair returned by a
 * {@link LocalizedActionExampleResolver}. The shape mirrors a single entry of
 * an action's `examples: ActionExample[][]` array — `[user, agent]`.
 */
export type LocalizedActionExamplePair = readonly [
	ActionExample,
	ActionExample,
];

/**
 * Callback the catalog uses to swap English `ActionExample` pairs for a
 * localized version when a translation is registered (typically by a
 * `MultilingualPromptRegistry`). Returning `null` keeps the English original.
 *
 * The resolver is index-based so callers (the planner, app-lifeops) can map
 * the pair back to its source row in `action.examples` without re-parsing the
 * registry's composite key shape (`<actionName>.example.<index>`).
 */
export type LocalizedActionExampleResolver = (params: {
	actionName: string;
	exampleIndex: number;
}) => LocalizedActionExamplePair | null;

export interface LocalizedExamplesProviderInput {
	/**
	 * Most-recent user-message text the planner is about to dispatch on. The
	 * provider uses this as a fallback signal when the canonical owner-locale
	 * isn't populated yet (e.g. first-message detection).
	 */
	recentMessage?: string | null;
}

/**
 * Async factory: produces a per-turn resolver bound to the owner's locale,
 * or `null` when the host has nothing to localize against (e.g. locale falls
 * back to the catalog's source language). Returning `null` lets
 * `buildActionCatalog` skip the resolver path entirely.
 */
export type LocalizedExamplesProvider = (
	input: LocalizedExamplesProviderInput,
) => Promise<LocalizedActionExampleResolver | null>;

const providers = new WeakMap<IAgentRuntime, LocalizedExamplesProvider>();

export function registerLocalizedExamplesProvider(
	runtime: IAgentRuntime,
	provider: LocalizedExamplesProvider,
): void {
	providers.set(runtime, provider);
}

export function getLocalizedExamplesProvider(
	runtime: IAgentRuntime,
): LocalizedExamplesProvider | null {
	return providers.get(runtime) ?? null;
}

export function __resetLocalizedExamplesProviderForTests(
	runtime: IAgentRuntime,
): void {
	providers.delete(runtime);
}
