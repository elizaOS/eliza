/**
 * Resolver factory binding a {@link MultilingualPromptRegistry} to a single
 * locale. Returns a `LocalizedActionExampleResolver` that the planner's
 * `buildActionCatalog` consumes to swap English `ActionExample` pairs for
 * the locale-specific variants registered by the default pack.
 *
 * Cycle-avoidance: this factory lives in app-lifeops because the registry
 * key shape (`<actionName>.example.<index>`) is part of the registry's
 * contract — keeping it consumer-side means core never imports plugin
 * symbols. The runtime hook at `getLocalizedExamplesProvider` (defined in
 * core) is the single seam between the two.
 */

import type { LocalizedActionExampleResolver } from "@elizaos/core";
import type {
  MultilingualPromptRegistry,
  PromptLocale,
} from "./prompt-registry.js";

const SUPPORTED_REGISTRY_LOCALES: ReadonlySet<PromptLocale> = new Set([
  "en",
  "es",
  "fr",
  "ja",
]);

function isSupportedRegistryLocale(value: string): value is PromptLocale {
  return SUPPORTED_REGISTRY_LOCALES.has(value as PromptLocale);
}

export interface LocalizedExamplesResolverOptions {
  registry: MultilingualPromptRegistry;
  /**
   * Locale tag to look up. When the tag is one our registry doesn't carry,
   * the resolver returns `null` for every lookup (English fall-through is
   * applied by `buildActionCatalog`'s caller — partial coverage is fine).
   */
  locale: string;
}

/**
 * Build a resolver that maps `(actionName, exampleIndex)` to the
 * `[user, agent]` pair registered under `<actionName>.example.<index>` for
 * `locale`. When the locale is unsupported by the registry the resolver is
 * a no-op (returns `null` every call), which keeps the catalog on its
 * English source.
 */
export function createLocalizedExamplesResolver(
  opts: LocalizedExamplesResolverOptions,
): LocalizedActionExampleResolver {
  if (!isSupportedRegistryLocale(opts.locale)) {
    return () => null;
  }
  const locale = opts.locale;
  const registry = opts.registry;

  return ({ actionName, exampleIndex }) => {
    const exampleKey = `${actionName}.example.${exampleIndex}`;
    const pair = registry.getPair(exampleKey, locale);
    if (!pair) {
      return null;
    }
    return pair;
  };
}
