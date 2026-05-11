/**
 * Runtime-level hook a host plugin (e.g. `@elizaos/app-lifeops`) registers so
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

import type { IAgentRuntime } from "../types/runtime";
import type { LocalizedActionExampleResolver } from "./action-catalog";

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
