/**
 * Async provider the planner runs once per turn to obtain a
 * locale-bound `LocalizedActionExampleResolver`. It reads the canonical
 * locale from `OwnerFactStore`, falls back to the lightweight heuristic
 * on the most-recent message (`detectLocaleFromText`), and finally to
 * the default locale (`"en"`). When the resolved locale is the source
 * language (`en`), this provider returns `null` so `buildActionCatalog`
 * skips the resolver path entirely.
 *
 * Wiring: registered in `plugin.ts` after `OwnerFactStore` and the
 * `MultilingualPromptRegistry` are available on the runtime.
 */

import {
	type LocalizedActionExampleResolver,
	type LocalizedExamplesProvider,
	resolveOwnerLocale,
} from "@elizaos/core";

import { getOwnerFactStore } from "../owner/fact-store.js";
import { createLocalizedExamplesResolver } from "./localized-examples-resolver.js";
import {
	getMultilingualPromptRegistry,
	PROMPT_REGISTRY_DEFAULT_LOCALE,
} from "./prompt-registry.js";
import type { IAgentRuntime } from "@elizaos/core";

export function createOwnerLocaleExamplesProvider(
	runtime: IAgentRuntime,
): LocalizedExamplesProvider {
	return async ({ recentMessage }) => {
		const registry = getMultilingualPromptRegistry(runtime);
		if (!registry) {
			return null;
		}
		const store = getOwnerFactStore(runtime);
		const ownerLocale = store
			? (await store.read()).locale?.value ?? null
			: null;
		const locale = resolveOwnerLocale({
			ownerLocale,
			recentMessage,
			defaultLocale: PROMPT_REGISTRY_DEFAULT_LOCALE,
		});
		if (locale === PROMPT_REGISTRY_DEFAULT_LOCALE) {
			return null;
		}
		const resolver: LocalizedActionExampleResolver =
			createLocalizedExamplesResolver({ registry, locale });
		return resolver;
	};
}
