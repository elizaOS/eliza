/**
 * Canonical character projection for shared-runtime inference and provisioning.
 * Keeping model precedence here ensures cache prewarm targets the same pricing
 * key that the first turn later consumes.
 */

import type { CharacterFailureTemplates } from "@elizaos/shared";
import type { UserCharacter } from "../../../db/repositories/characters";
import type { SharedAgentCharacter, SharedFailureTemplates } from "./run-shared-agent-turn";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

const SHARED_CHARACTER_TEXT_BUDGET = 48_000;
const NAME_MAX = 100;
const SYSTEM_MAX = 10_000;
const LIST_ITEMS_MAX = 32;
const LIST_ITEM_MAX = 2_000;
const TRAIT_ITEMS_MAX = 64;
const TRAIT_ITEM_MAX = 100;
const EXAMPLE_GROUPS_MAX = 5;
const EXAMPLES_PER_GROUP_MAX = 8;
const EXAMPLE_TEXT_MAX = 2_000;
const EXAMPLE_ACTIONS_MAX = 16;
const FAILURE_TEMPLATE_MAX = 2_000;

type TextBudget = { remaining: number };

function stringValue(value: unknown, max = Number.POSITIVE_INFINITY): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function budgetedString(value: unknown, budget: TextBudget, max: number): string | undefined {
  const text = stringValue(value, Math.min(max, budget.remaining));
  if (!text) return undefined;
  budget.remaining -= text.length;
  return text;
}

function stringList(
  value: unknown,
  budget: TextBudget,
  itemMax = LIST_ITEM_MAX,
  itemsMax = LIST_ITEMS_MAX,
): string[] {
  if (typeof value === "string") {
    const item = budgetedString(value, budget, itemMax);
    return item ? [item] : [];
  }
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const valueItem of value.slice(0, itemsMax)) {
    const item = budgetedString(valueItem, budget, itemMax);
    if (item) items.push(item);
    if (budget.remaining === 0) break;
  }
  return items;
}

function firstStringList(
  budget: TextBudget,
  values: unknown[],
  itemMax = LIST_ITEM_MAX,
  itemsMax = LIST_ITEMS_MAX,
): string[] {
  for (const value of values) {
    const list = stringList(value, budget, itemMax, itemsMax);
    if (list.length > 0) return list;
  }
  return [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function styleValue(
  budget: TextBudget,
  ...values: unknown[]
): SharedAgentCharacter["style"] | undefined {
  for (const value of values) {
    const candidate = record(value);
    if (!candidate) continue;
    const style = {
      all: stringList(candidate.all, budget),
      chat: stringList(candidate.chat, budget),
      post: stringList(candidate.post, budget),
    };
    if (style.all.length || style.chat.length || style.post.length) return style;
  }
  return undefined;
}

const FAILURE_TEMPLATE_KEYS = [
  "authFailedReply",
  "insufficientCreditsReply",
  "noModelProviderReply",
  "missingCapabilityFailureReply",
  "plannerExhaustionFailureReply",
  "rateLimitedReply",
  "transientFailureReply",
] as const satisfies readonly (keyof CharacterFailureTemplates)[];

function templatesValue(...values: unknown[]): SharedFailureTemplates | undefined {
  for (const value of values) {
    const candidate = record(value);
    if (!candidate) continue;
    const templates = {} as SharedFailureTemplates;
    for (const key of FAILURE_TEMPLATE_KEYS) {
      const template = stringValue(candidate[key], FAILURE_TEMPLATE_MAX);
      if (template) templates[key] = template;
    }
    if (Object.keys(templates).length > 0) return templates;
  }
  return undefined;
}

function messageExamplesValue(
  budget: TextBudget,
  ...values: unknown[]
): NonNullable<SharedAgentCharacter["messageExamples"]> {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const groups = value.slice(0, EXAMPLE_GROUPS_MAX).flatMap((group) => {
      const rawMessages = Array.isArray(group) ? group : record(group)?.examples;
      if (!Array.isArray(rawMessages)) return [];
      const examples = rawMessages.slice(0, EXAMPLES_PER_GROUP_MAX).flatMap((message) => {
        const candidate = record(message);
        const content = record(candidate?.content);
        const name = budgetedString(candidate?.name ?? candidate?.user, budget, NAME_MAX);
        const text = budgetedString(content?.text, budget, EXAMPLE_TEXT_MAX);
        if (!name || !text) return [];
        const actions = stringList(content?.actions, budget, TRAIT_ITEM_MAX, EXAMPLE_ACTIONS_MAX);
        return [{ name, content: { text, ...(actions.length ? { actions } : {}) } }];
      });
      return examples.length ? [{ examples }] : [];
    });
    if (groups.length > 0) return groups;
  }
  return [];
}

/** Build the shared-turn character with linked, nested, then top-level precedence. */
export function projectSharedAgentCharacter(
  agent: SharedRuntimeAgent,
  linked?: UserCharacter | null,
): SharedAgentCharacter {
  if (linked && linked.organization_id !== agent.organization_id) {
    throw new Error("[shared-runtime] linked character organization mismatch");
  }
  const config = record(agent.agent_config) ?? {};
  const configuredCharacter = record(config.character) ?? config;
  const settings = record(linked?.settings);
  // This is an untrusted multi-tenant boundary. Bound both traversal and the
  // retained character corpus before either runtime turns it into model input.
  const budget: TextBudget = { remaining: SHARED_CHARACTER_TEXT_BUDGET };
  const name =
    budgetedString(linked?.name, budget, NAME_MAX) ??
    budgetedString(configuredCharacter.name, budget, NAME_MAX) ??
    budgetedString(config.name, budget, NAME_MAX) ??
    budgetedString(agent.agent_name, budget, NAME_MAX) ??
    budgetedString("Eliza agent", budget, NAME_MAX)!;
  const system =
    budgetedString(linked?.system, budget, SYSTEM_MAX) ??
    budgetedString(configuredCharacter.system, budget, SYSTEM_MAX) ??
    budgetedString(config.system, budget, SYSTEM_MAX) ??
    budgetedString(configuredCharacter.prompt, budget, SYSTEM_MAX) ??
    budgetedString(config.prompt, budget, SYSTEM_MAX) ??
    budgetedString(`You are ${name}, a helpful assistant.`, budget, SYSTEM_MAX)!;
  const bio = firstStringList(budget, [linked?.bio, configuredCharacter.bio, config.bio]);
  const messageExamples = messageExamplesValue(
    budget,
    linked?.message_examples,
    configuredCharacter.messageExamples,
    configuredCharacter.message_examples,
    config.messageExamples,
    config.message_examples,
  );
  const postExamples = firstStringList(budget, [
    linked?.post_examples,
    configuredCharacter.postExamples,
    configuredCharacter.post_examples,
    config.postExamples,
    config.post_examples,
  ]);
  const topics = firstStringList(
    budget,
    [linked?.topics, configuredCharacter.topics, config.topics],
    TRAIT_ITEM_MAX,
    TRAIT_ITEMS_MAX,
  );
  const adjectives = firstStringList(
    budget,
    [linked?.adjectives, configuredCharacter.adjectives, config.adjectives],
    TRAIT_ITEM_MAX,
    TRAIT_ITEMS_MAX,
  );
  const style = styleValue(budget, linked?.style, configuredCharacter.style, config.style);
  const characterData = record(linked?.character_data);
  const configuredCharacterData = record(configuredCharacter.character_data);
  const configCharacterData = record(config.character_data);
  const templates = templatesValue(
    characterData?.templates,
    configuredCharacterData?.templates,
    configCharacterData?.templates,
    configuredCharacter.templates,
    config.templates,
  );
  const model =
    stringValue(settings?.model, 200) ??
    stringValue(configuredCharacter.model, 200) ??
    stringValue(config.model, 200);
  return {
    name,
    system,
    ...(bio.length ? { bio } : {}),
    ...(messageExamples.length ? { messageExamples } : {}),
    ...(postExamples.length ? { postExamples } : {}),
    ...(topics.length ? { topics } : {}),
    ...(adjectives.length ? { adjectives } : {}),
    ...(style ? { style } : {}),
    ...(templates ? { templates } : {}),
    ...(model ? { model } : {}),
  };
}
