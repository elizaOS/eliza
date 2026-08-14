/**
 * Canonical character projection for shared-runtime inference and provisioning.
 * Keeping model precedence here ensures cache prewarm targets the same pricing
 * key that the first turn later consumes.
 */

import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import type { UserCharacter } from "../../../db/repositories/characters";
import type { SharedAgentCharacter } from "./run-shared-agent-turn";

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Build the shared-turn character with linked, nested, then top-level precedence. */
export function projectSharedAgentCharacter(
  agent: AgentSandbox,
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
  const bio = [
    ...stringList(linked?.bio),
    ...stringList(configuredCharacter.bio),
    ...stringList(config.bio),
  ];
  const model =
    stringValue(settings?.model) ??
    stringValue(configuredCharacter.model) ??
    stringValue(config.model);
  return {
    name,
    system,
    ...(bio.length ? { bio } : {}),
    ...(model ? { model } : {}),
  };
}
