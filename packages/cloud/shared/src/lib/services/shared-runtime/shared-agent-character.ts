/**
 * Canonical character projection for shared-runtime inference and provisioning.
 * Keeping model precedence here ensures cache prewarm targets the same pricing
 * key that the first turn later consumes.
 */

import type { UserCharacter } from "../../../db/repositories/characters";
import type { SharedAgentCharacter } from "./run-shared-agent-turn";
import type { SharedRuntimeAgent } from "./shared-runtime-agent";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function firstStringList(...values: unknown[]): string[] {
  for (const value of values) {
    const list = stringList(value);
    if (list.length > 0) return list;
  }
  return [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function styleValue(...values: unknown[]): SharedAgentCharacter["style"] | undefined {
  for (const value of values) {
    const candidate = record(value);
    if (!candidate) continue;
    const style = {
      all: stringList(candidate.all),
      chat: stringList(candidate.chat),
      post: stringList(candidate.post),
    };
    if (style.all.length || style.chat.length || style.post.length) return style;
  }
  return undefined;
}

function templatesValue(...values: unknown[]): Record<string, string> | undefined {
  for (const value of values) {
    const candidate = record(value);
    if (!candidate) continue;
    const templates = Object.fromEntries(
      Object.entries(candidate).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && entry[1].trim().length > 0,
      ),
    );
    if (Object.keys(templates).length > 0) return templates;
  }
  return undefined;
}

function messageExamplesValue(
  ...values: unknown[]
): NonNullable<SharedAgentCharacter["messageExamples"]> {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const groups = value.flatMap((group) => {
      const rawMessages = Array.isArray(group) ? group : record(group)?.examples;
      if (!Array.isArray(rawMessages)) return [];
      const examples = rawMessages.flatMap((message) => {
        const candidate = record(message);
        const content = record(candidate?.content);
        const name = stringValue(candidate?.name ?? candidate?.user);
        const text = stringValue(content?.text);
        if (!name || !text) return [];
        const actions = stringList(content?.actions);
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
  const name =
    stringValue(linked?.name) ??
    stringValue(configuredCharacter.name) ??
    stringValue(config.name) ??
    agent.agent_name ??
    "Eliza agent";
  const system =
    stringValue(linked?.system) ??
    stringValue(configuredCharacter.system) ??
    stringValue(config.system) ??
    stringValue(configuredCharacter.prompt) ??
    stringValue(config.prompt) ??
    `You are ${name}, a helpful assistant.`;
  const bio = firstStringList(linked?.bio, configuredCharacter.bio, config.bio);
  const messageExamples = messageExamplesValue(
    linked?.message_examples,
    configuredCharacter.messageExamples,
    configuredCharacter.message_examples,
    config.messageExamples,
    config.message_examples,
  );
  const postExamples = firstStringList(
    linked?.post_examples,
    configuredCharacter.postExamples,
    configuredCharacter.post_examples,
    config.postExamples,
    config.post_examples,
  );
  const topics = firstStringList(linked?.topics, configuredCharacter.topics, config.topics);
  const adjectives = firstStringList(
    linked?.adjectives,
    configuredCharacter.adjectives,
    config.adjectives,
  );
  const style = styleValue(linked?.style, configuredCharacter.style, config.style);
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
    stringValue(settings?.model) ??
    stringValue(configuredCharacter.model) ??
    stringValue(config.model);
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
