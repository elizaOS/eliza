/**
 * Projects the canonical cloud Eliza persona into flat sandbox configuration.
 * Managed create, warm-claim, shared-runtime, and container-bootstrap paths all
 * consume this shape. The projection omits `name` so column renames keep taking
 * effect, preserves name tokens for render time, and emits strict-form message
 * examples accepted by the character API.
 */

import { getDefaultStylePreset } from "@elizaos/shared/character-presets";
import { buildCloudElizaPersona } from "../utils/cloud-eliza-persona";

/**
 * Persona-bearing keys. A create whose caller-supplied config already fills any
 * of these (flat, or nested under `character`) is left untouched — the caller
 * brought their own persona and the seed must not compete with it.
 */
const PERSONA_KEYS = ["system", "prompt", "bio"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a persona field carries usable content. Mirrors what the readers
 * accept, so a blank string or an all-blank array counts as absent here exactly
 * as it does there — otherwise it would suppress the seed and still render the
 * stub.
 */
function hasPersonaValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === "string" && entry.trim().length > 0);
  }
  return false;
}

function hasPersonaKey(config: Record<string, unknown>): boolean {
  return PERSONA_KEYS.some((key) => hasPersonaValue(config[key]));
}

/**
 * Whether `agent_config` already describes a character, in either the flat or
 * the nested `{ character: {...} }` shape.
 */
export function agentConfigHasCharacter(agentConfig?: Record<string, unknown> | null): boolean {
  const config = asRecord(agentConfig);
  if (!config) return false;
  if (hasPersonaKey(config)) return true;
  const nested = asRecord(config.character);
  return nested ? hasPersonaKey(nested) : false;
}

/**
 * The shipped default preset ("eliza") projected onto the flat `agent_config`
 * persona keys. Returns a fresh object per call so a stored row never aliases
 * the preset catalog.
 */
export function buildDefaultAgentCharacterConfig(): Record<string, unknown> {
  const preset = buildCloudElizaPersona();
  return {
    system: preset.system,
    bio: [...preset.bio],
    adjectives: [...preset.adjectives],
    topics: [...preset.topics],
    style: {
      all: [...preset.style.all],
      chat: [...preset.style.chat],
      post: [...preset.style.post],
    },
    postExamples: [...preset.postExamples],
    messageExamples: preset.messageExamples.map((group) => ({
      examples: group.map((turn) => ({ name: turn.user, content: { ...turn.content } })),
    })),
    ...(preset.templates ? { templates: { ...preset.templates } } : {}),
  };
}

function hasLegacyDefaultBio(config: Record<string, unknown>): boolean {
  const bio = config.bio;
  if (!Array.isArray(bio)) return false;
  const presetBio = getDefaultStylePreset().bio;
  return bio.length === presetBio.length && bio.every((entry, index) => entry === presetBio[index]);
}

/**
 * Seed the default persona under a caller's `agent_config`. Caller keys always
 * win, and a config that already carries a persona is returned unchanged, so
 * this can only ever fill the gap a persona-less create would otherwise leave.
 *
 * The one key the caller does not win is a BLANK persona field: `{ system: "" }`
 * carries no persona, and letting it survive the merge would shadow the seed and
 * put the reader back on its stub.
 */
export function withDefaultAgentCharacter(
  agentConfig?: Record<string, unknown> | null,
): Record<string, unknown> {
  const config = asRecord(agentConfig) ?? {};
  if (agentConfigHasCharacter(config) && !hasLegacyDefaultBio(config)) return { ...config };
  const carried = Object.fromEntries(
    Object.entries(config).filter(([key]) => !(PERSONA_KEYS as readonly string[]).includes(key)),
  );
  return { ...buildDefaultAgentCharacterConfig(), ...carried };
}
