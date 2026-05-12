/**
 * `MultilingualPromptRegistry` — registry for localized `ActionExample`
 * pairs and short prompt fragments referenced by `exampleKey`.
 *
 * Background (per `IMPLEMENTATION_PLAN.md` §5.5 and `GAP_ASSESSMENT.md`
 * §3.7): action examples and routing hints live as registered translation
 * tables, not as `ActionExample` literals embedded in source. The user's
 * locale is read from `OwnerFactStore.locale`; the planner can ask the
 * registry for a localized example when surfacing the prompt to the LLM.
 *
 * The registry's only persistent state is in-memory; the default pack is
 * loaded by `registerDefaultPromptPack`. The registry is registered onto
 * the runtime so other actions / providers can resolve example pairs by
 * key without owning the table themselves.
 */

import type { ActionExample, IAgentRuntime } from "@elizaos/core";

export type PromptLocale = "en" | "es" | "fr" | "ja";

const SUPPORTED_LOCALES: ReadonlyArray<PromptLocale> = [
  "en",
  "es",
  "fr",
  "ja",
];

const DEFAULT_LOCALE: PromptLocale = "en";

export interface PromptExampleEntry {
  /** Stable key referenced by actions, e.g. `"OWNER_ROUTINES.example.0"`. */
  exampleKey: string;
  /** Locale this entry covers. */
  locale: PromptLocale;
  /** Speaker turn for the user side. Use the standard `{{name1}}` template. */
  user: ActionExample;
  /** Speaker turn for the agent reply. Use the standard `{{agentName}}` template. */
  agent: ActionExample;
}

export interface PromptRegistryFilter {
  exampleKey?: string;
  locale?: PromptLocale;
}

export interface MultilingualPromptRegistry {
  register(entry: PromptExampleEntry): void;
  /** Returns the full pair (`[user, agent]`) or null if unregistered. */
  getPair(
    exampleKey: string,
    locale: PromptLocale,
  ): readonly [ActionExample, ActionExample] | null;
  /** Returns the matching entry or null. */
  get(exampleKey: string, locale: PromptLocale): PromptExampleEntry | null;
  /** Lists every entry, optionally filtered. */
  list(filter?: PromptRegistryFilter): PromptExampleEntry[];
  keys(): string[];
}

class InMemoryPromptRegistry implements MultilingualPromptRegistry {
  private readonly byKeyAndLocale = new Map<string, PromptExampleEntry>();

  register(entry: PromptExampleEntry): void {
    if (!entry.exampleKey) {
      throw new Error("PromptExampleEntry.exampleKey is required");
    }
    if (!isSupportedLocale(entry.locale)) {
      throw new Error(
        `PromptExampleEntry.locale "${entry.locale}" is not supported`,
      );
    }
    const compositeKey = makeCompositeKey(entry.exampleKey, entry.locale);
    if (this.byKeyAndLocale.has(compositeKey)) {
      throw new Error(
        `Prompt example "${entry.exampleKey}" already registered for locale "${entry.locale}"`,
      );
    }
    this.byKeyAndLocale.set(compositeKey, entry);
  }

  get(exampleKey: string, locale: PromptLocale): PromptExampleEntry | null {
    return (
      this.byKeyAndLocale.get(makeCompositeKey(exampleKey, locale)) ?? null
    );
  }

  getPair(
    exampleKey: string,
    locale: PromptLocale,
  ): readonly [ActionExample, ActionExample] | null {
    const entry = this.get(exampleKey, locale);
    if (!entry) {
      return null;
    }
    return [entry.user, entry.agent];
  }

  list(filter?: PromptRegistryFilter): PromptExampleEntry[] {
    const all = [...this.byKeyAndLocale.values()];
    if (!filter) {
      return all;
    }
    return all.filter((entry) => {
      if (filter.exampleKey && entry.exampleKey !== filter.exampleKey) {
        return false;
      }
      if (filter.locale && entry.locale !== filter.locale) {
        return false;
      }
      return true;
    });
  }

  keys(): string[] {
    const keys = new Set<string>();
    for (const entry of this.byKeyAndLocale.values()) {
      keys.add(entry.exampleKey);
    }
    return [...keys].sort();
  }
}

function isSupportedLocale(value: string): value is PromptLocale {
  return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value);
}

function makeCompositeKey(exampleKey: string, locale: PromptLocale): string {
  return `${locale}::${exampleKey}`;
}

export function createMultilingualPromptRegistry(): MultilingualPromptRegistry {
  return new InMemoryPromptRegistry();
}

// --- Runtime registration -------------------------------------------------

const REGISTRY_KEY = Symbol.for(
  "@elizaos/app-lifeops:multilingual-prompt-registry",
);

interface RegistryHostRuntime extends IAgentRuntime {
  [REGISTRY_KEY]?: MultilingualPromptRegistry;
}

export function registerMultilingualPromptRegistry(
  runtime: IAgentRuntime,
  registry: MultilingualPromptRegistry,
): void {
  (runtime as RegistryHostRuntime)[REGISTRY_KEY] = registry;
}

export function getMultilingualPromptRegistry(
  runtime: IAgentRuntime,
): MultilingualPromptRegistry | null {
  return (runtime as RegistryHostRuntime)[REGISTRY_KEY] ?? null;
}

// --- Default pack ---------------------------------------------------------

const OWNER_ROUTINES_EXAMPLES: ReadonlyArray<PromptExampleEntry> = [
  {
    exampleKey: "OWNER_ROUTINES.example.0",
    locale: "en",
    user: {
      name: "{{name1}}",
      content: {
        text: "help me brush my teeth at 8 am and 9 pm every day",
      },
    },
    agent: {
      name: "{{agentName}}",
      content: {
        text: 'I can set up a habit named "Brush teeth" for 8 am and 9 pm daily. Confirm and I\'ll save it.',
        actions: ["OWNER_ROUTINES"],
      },
    },
  },
  {
    exampleKey: "OWNER_ROUTINES.example.0",
    locale: "es",
    user: {
      name: "{{name1}}",
      content: {
        text: "recuérdame cepillarme los dientes por la mañana y por la noche",
      },
    },
    agent: {
      name: "{{agentName}}",
      content: {
        text: "Puedo guardar ese hábito para la mañana y la noche. Confirma y lo guardo.",
        actions: ["OWNER_ROUTINES"],
      },
    },
  },
  {
    exampleKey: "OWNER_ROUTINES.example.0",
    locale: "fr",
    user: {
      name: "{{name1}}",
      content: {
        text: "aide-moi a me brosser les dents a 8 h et 21 h tous les jours",
      },
    },
    agent: {
      name: "{{agentName}}",
      content: {
        text: 'Je peux configurer une habitude "Brush teeth" pour 8 h et 21 h tous les jours. Confirmez et je l\'enregistrerai.',
        actions: ["OWNER_ROUTINES"],
      },
    },
  },
  {
    exampleKey: "OWNER_ROUTINES.example.0",
    locale: "ja",
    user: {
      name: "{{name1}}",
      content: {
        text: "毎日8時と21時に歯磨きを手伝って",
      },
    },
    agent: {
      name: "{{agentName}}",
      content: {
        text: "毎日8時と21時の習慣として歯磨きを設定できます。確認したら保存します。",
        actions: ["OWNER_ROUTINES"],
      },
    },
  },
];

export function registerDefaultPromptPack(
  registry: MultilingualPromptRegistry,
): void {
  for (const entry of OWNER_ROUTINES_EXAMPLES) {
    registry.register(entry);
  }
}

/**
 * Convenience for actions: build an `[user, agent]` pair list from a
 * (key, locale) tuple set. Throws when an entry is missing — actions
 * declare exactly which examples they need, so a missing one indicates a
 * registration error and should fail fast at module-init time.
 */
export function resolveActionExamplePairs(
  registry: MultilingualPromptRegistry,
  references: ReadonlyArray<{ exampleKey: string; locale: PromptLocale }>,
): ActionExample[][] {
  return references.map(({ exampleKey, locale }) => {
    const pair = registry.getPair(exampleKey, locale);
    if (!pair) {
      throw new Error(
        `Prompt example "${exampleKey}" (locale="${locale}") is not registered`,
      );
    }
    return [pair[0], pair[1]];
  });
}

export const PROMPT_REGISTRY_DEFAULT_LOCALE: PromptLocale = DEFAULT_LOCALE;

// --- Default registry singleton (module-load consumers) -------------------

/**
 * Module-level default registry, pre-populated with the default pack. Used
 * by actions that need to embed localized example pairs in their static
 * `examples: ActionExample[][]` arrays at module-load time (the runtime
 * registry isn't available at module-load).
 *
 * Runtime-scoped consumers should still use `getMultilingualPromptRegistry`
 * — this singleton is the read-only fallback for static contexts.
 */
let defaultRegistrySingleton: MultilingualPromptRegistry | null = null;

export function getDefaultPromptRegistry(): MultilingualPromptRegistry {
  if (!defaultRegistrySingleton) {
    const registry = createMultilingualPromptRegistry();
    registerDefaultPromptPack(registry);
    defaultRegistrySingleton = registry;
  }
  return defaultRegistrySingleton;
}

/**
 * Resolve a single localized example pair from the default registry.
 * Throws when the key isn't registered (intentional — fail fast at
 * module-init).
 */
export function getDefaultPromptExamplePair(
  exampleKey: string,
  locale: PromptLocale,
): readonly [ActionExample, ActionExample] {
  const pair = getDefaultPromptRegistry().getPair(exampleKey, locale);
  if (!pair) {
    throw new Error(
      `Prompt example "${exampleKey}" (locale="${locale}") is not registered in the default pack`,
    );
  }
  return pair;
}
