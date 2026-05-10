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
import { app_block_es_examples } from "./generated/app-block.es.js";
import { app_block_fr_examples } from "./generated/app-block.fr.js";
import { autofill_es_examples } from "./generated/autofill.es.js";
import { autofill_fr_examples } from "./generated/autofill.fr.js";
import { block_es_examples } from "./generated/block.es.js";
import { block_fr_examples } from "./generated/block.fr.js";
import { book_travel_es_examples } from "./generated/book-travel.es.js";
import { book_travel_fr_examples } from "./generated/book-travel.fr.js";
import { calendar_es_examples } from "./generated/calendar.es.js";
import { calendar_fr_examples } from "./generated/calendar.fr.js";
import { checkin_es_examples } from "./generated/checkin.es.js";
import { checkin_fr_examples } from "./generated/checkin.fr.js";
import { connector_es_examples } from "./generated/connector.es.js";
import { connector_fr_examples } from "./generated/connector.fr.js";
import { credentials_es_examples } from "./generated/credentials.es.js";
import { credentials_fr_examples } from "./generated/credentials.fr.js";
import { device_intent_es_examples } from "./generated/device-intent.es.js";
import { device_intent_fr_examples } from "./generated/device-intent.fr.js";
import { entity_es_examples } from "./generated/entity.es.js";
import { entity_fr_examples } from "./generated/entity.fr.js";
import { first_run_es_examples } from "./generated/first-run.es.js";
import { first_run_fr_examples } from "./generated/first-run.fr.js";
import { health_es_examples } from "./generated/health.es.js";
import { health_fr_examples } from "./generated/health.fr.js";
import { life_es_examples } from "./generated/life.es.js";
import { life_fr_examples } from "./generated/life.fr.js";
import { lifeops_es_examples } from "./generated/lifeops-pause.es.js";
import { lifeops_fr_examples } from "./generated/lifeops-pause.fr.js";
import { message_handoff_es_examples } from "./generated/message-handoff.es.js";
import { message_handoff_fr_examples } from "./generated/message-handoff.fr.js";
import { money_es_examples } from "./generated/money.es.js";
import { money_fr_examples } from "./generated/money.fr.js";
import { password_manager_es_examples } from "./generated/password-manager.es.js";
import { password_manager_fr_examples } from "./generated/password-manager.fr.js";
import { payments_es_examples } from "./generated/payments.es.js";
import { payments_fr_examples } from "./generated/payments.fr.js";
import { profile_es_examples } from "./generated/profile.es.js";
import { profile_fr_examples } from "./generated/profile.fr.js";
import { relationship_es_examples } from "./generated/relationship.es.js";
import { relationship_fr_examples } from "./generated/relationship.fr.js";
import { remote_desktop_es_examples } from "./generated/remote-desktop.es.js";
import { remote_desktop_fr_examples } from "./generated/remote-desktop.fr.js";
import { resolve_request_es_examples } from "./generated/resolve-request.es.js";
import { resolve_request_fr_examples } from "./generated/resolve-request.fr.js";
import { schedule_es_examples } from "./generated/schedule.es.js";
import { schedule_fr_examples } from "./generated/schedule.fr.js";
import { scheduled_task_es_examples } from "./generated/scheduled-task.es.js";
import { scheduled_task_fr_examples } from "./generated/scheduled-task.fr.js";
import { screen_time_es_examples } from "./generated/screen-time.es.js";
import { screen_time_fr_examples } from "./generated/screen-time.fr.js";
import { subscriptions_es_examples } from "./generated/subscriptions.es.js";
import { subscriptions_fr_examples } from "./generated/subscriptions.fr.js";
import { toggle_feature_es_examples } from "./generated/toggle-feature.es.js";
import { toggle_feature_fr_examples } from "./generated/toggle-feature.fr.js";
import { voice_call_es_examples } from "./generated/voice-call.es.js";
import { voice_call_fr_examples } from "./generated/voice-call.fr.js";
import { website_block_es_examples } from "./generated/website-block.es.js";
import { website_block_fr_examples } from "./generated/website-block.fr.js";

export type PromptLocale = "en" | "es" | "fr" | "ja";

const SUPPORTED_LOCALES: ReadonlyArray<PromptLocale> = [
  "en",
  "es",
  "fr",
  "ja",
];

const DEFAULT_LOCALE: PromptLocale = "en";

export interface PromptExampleEntry {
  /** Stable key referenced by actions, e.g. `"life.brush_teeth"`. */
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

/**
 * Localized example for the LIFE create_definition flow that previously
 * lived inline in `actions/life.ts`. The Spanish row was the only inline
 * non-English example before W2-E; this table is the source-of-truth now.
 */
const LIFE_BRUSH_TEETH_EXAMPLES: ReadonlyArray<PromptExampleEntry> = [
  {
    exampleKey: "life.brush_teeth.create_definition",
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
        actions: ["LIFE"],
      },
    },
  },
  {
    exampleKey: "life.brush_teeth.create_definition",
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
        actions: ["LIFE"],
      },
    },
  },
];

/**
 * Generated translation packs from
 * `plugins/app-lifeops/scripts/translate-action-examples.mjs`. Each entry is
 * a Spanish or French translation of an English ActionExample pair found in
 * the source action file. The registry composite key is
 * `<actionName>.example.<index>`, which matches the index of the source pair
 * in the action's `examples: ActionExample[][]` array.
 *
 * Coverage: every example-bearing app-lifeops action × {es, fr}. Action files
 * outside app-lifeops are tracked as future bulk-pass scope in
 * `docs/audit/translation-harness.md`.
 */
const GENERATED_TRANSLATION_PACKS: ReadonlyArray<
  ReadonlyArray<PromptExampleEntry>
> = [
  app_block_es_examples,
  app_block_fr_examples,
  autofill_es_examples,
  autofill_fr_examples,
  block_es_examples,
  block_fr_examples,
  book_travel_es_examples,
  book_travel_fr_examples,
  calendar_es_examples,
  calendar_fr_examples,
  checkin_es_examples,
  checkin_fr_examples,
  connector_es_examples,
  connector_fr_examples,
  credentials_es_examples,
  credentials_fr_examples,
  device_intent_es_examples,
  device_intent_fr_examples,
  entity_es_examples,
  entity_fr_examples,
  first_run_es_examples,
  first_run_fr_examples,
  health_es_examples,
  health_fr_examples,
  life_es_examples,
  life_fr_examples,
  lifeops_es_examples,
  lifeops_fr_examples,
  message_handoff_es_examples,
  message_handoff_fr_examples,
  money_es_examples,
  money_fr_examples,
  password_manager_es_examples,
  password_manager_fr_examples,
  payments_es_examples,
  payments_fr_examples,
  profile_es_examples,
  profile_fr_examples,
  relationship_es_examples,
  relationship_fr_examples,
  remote_desktop_es_examples,
  remote_desktop_fr_examples,
  resolve_request_es_examples,
  resolve_request_fr_examples,
  schedule_es_examples,
  schedule_fr_examples,
  scheduled_task_es_examples,
  scheduled_task_fr_examples,
  screen_time_es_examples,
  screen_time_fr_examples,
  subscriptions_es_examples,
  subscriptions_fr_examples,
  toggle_feature_es_examples,
  toggle_feature_fr_examples,
  voice_call_es_examples,
  voice_call_fr_examples,
  website_block_es_examples,
  website_block_fr_examples,
];

export function registerDefaultPromptPack(
  registry: MultilingualPromptRegistry,
): void {
  for (const entry of LIFE_BRUSH_TEETH_EXAMPLES) {
    registry.register(entry);
  }
  for (const pack of GENERATED_TRANSLATION_PACKS) {
    for (const entry of pack) {
      registry.register(entry);
    }
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
