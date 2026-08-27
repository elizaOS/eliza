/**
 * Warm-pool claim → character push payload builder.
 *
 * A warm pool container boots GENERIC (HetznerPoolContainerCreator provisions
 * it with `environment_vars: {}` — no ELIZA_AGENT_CHARACTER_JSON), so after a
 * claim the RUNNING container would answer as the default Eliza preset even
 * though the DB row now carries the user's agent_name / agent_config /
 * character_id. The fix is a post-claim runtime push: the container's own
 * `PUT /api/character` route (packages/agent character-routes.ts) applies
 * name/system/bio/style/examples to the live runtime, persists them to the
 * agent's DB (updateAgent metadata) and journals character history — no
 * restart, no cold boot.
 *
 * That route validates with the agent's STRICT CharacterSchema
 * (packages/agent/src/config/character-schema.ts): unknown keys are rejected
 * at parse time and fields carry max lengths. `agent_config` is a loose
 * user-supplied blob (plugins, settings, secrets, connectors, ...), so this
 * builder projects it down to EXACTLY the schema's accepted shape:
 *
 *   - whitelist: name, username, system, bio, adjectives, topics, style,
 *     messageExamples, postExamples (everything else — plugins, settings,
 *     secrets, connectors, knowledge — is dropped; secrets must NEVER ride
 *     along on this call anyway);
 *   - strings are Unicode-normalized but never shortened. If a downstream
 *     schema cannot accept the complete character, that boundary rejects the
 *     payload explicitly instead of silently changing the character;
 *   - messageExamples are included ONLY when they already match the strict
 *     `[{ examples: [{ name, content: { text, actions? } }] }]` group form
 *     (extra content keys are stripped); the legacy `[[{user,content}]]` form
 *     is omitted — the boot-time env path normalises it on the next restart.
 *
 * Returns null when there is no name to push (no config name and no
 * agent_name), in which case the caller skips the push entirely.
 */

import { toWellFormedUnicode } from "@elizaos/core/edge";

import { applyRemoteDockerRuntimeMode } from "./remote-docker-runtime-mode";

/**
 * Boot-coupled env keys: values the RUNNING pool container was started with
 * that MUST follow the container onto the claimed user row, or every
 * authenticated call to it (the character push below, the bridge proxy, the
 * agent-router web UI gate) checks the wrong credential:
 *
 *   - ELIZA_API_TOKEN — the container's inbound API auth boundary
 *     (getAgentApiToken reads the ROW's value and the container validates its
 *     own process env's value; they must be the same token);
 *   - JWT_SECRET — per-container session secret generated at boot;
 *   - AGENT_SERVER_SHARED_SECRET — the X-Server-Token gateway secret the
 *     container booted with.
 *
 * Everything else on the user's row (their BYO secrets, managed cloud keys)
 * is preserved except the platform pairing mode, which is forced back to the
 * remote value after the merge so a historical user row cannot contradict the
 * already-running pool container.
 */
const WARM_CLAIM_BOOT_COUPLED_ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "JWT_SECRET",
  "AGENT_SERVER_SHARED_SECRET",
] as const;

/**
 * Merge a claimed pool row's boot-coupled env keys onto the user row's env.
 * User keys win everywhere EXCEPT the boot-coupled set, where the container's
 * actual boot values are authoritative (the container is already running with
 * them and cannot be told otherwise without a restart).
 */
export function mergeWarmClaimEnvironmentVars(
  userEnv: Record<string, string> | null | undefined,
  poolEnv: Record<string, string> | null | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...(userEnv ?? {}) };
  for (const key of WARM_CLAIM_BOOT_COUPLED_ENV_KEYS) {
    const value = poolEnv?.[key];
    if (typeof value === "string" && value.trim()) {
      merged[key] = value;
    }
  }
  return applyRemoteDockerRuntimeMode(merged);
}

/** Bounded timeout for the post-claim character push HTTP call. */
export const WARM_CLAIM_CHARACTER_PUSH_TIMEOUT_MS = 10_000;

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map(toWellFormedUnicode);
  return items.length > 0 ? items : undefined;
}

type MessageExampleGroup = {
  examples: Array<{ name: string; content: { text: string; actions?: string[] } }>;
};

/**
 * Accept message examples ONLY in the strict group form the agent's
 * CharacterSchema validates; strip unknown content keys. Any structural
 * mismatch returns undefined (omit the field) rather than risking a 422.
 */
function sanitizeMessageExampleGroups(value: unknown): MessageExampleGroup[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const groups: MessageExampleGroup[] = [];
  for (const rawGroup of value) {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) return undefined;
    const rawExamples = (rawGroup as { examples?: unknown }).examples;
    if (!Array.isArray(rawExamples) || rawExamples.length === 0) return undefined;
    const examples: MessageExampleGroup["examples"] = [];
    for (const rawExample of rawExamples) {
      if (!rawExample || typeof rawExample !== "object") return undefined;
      const name = (rawExample as { name?: unknown }).name;
      const content = (rawExample as { content?: unknown }).content;
      const text =
        content && typeof content === "object" ? (content as { text?: unknown }).text : undefined;
      if (typeof name !== "string" || !name.trim()) return undefined;
      if (typeof text !== "string" || !text.trim()) return undefined;
      const rawActions = (content as { actions?: unknown }).actions;
      const actions = Array.isArray(rawActions)
        ? rawActions.filter((a): a is string => typeof a === "string" && a.length > 0)
        : undefined;
      examples.push({
        name: toWellFormedUnicode(name),
        content: {
          text: toWellFormedUnicode(text),
          ...(actions && actions.length > 0 ? { actions: actions.map(toWellFormedUnicode) } : {}),
        },
      });
    }
    groups.push({ examples });
  }
  return groups.length > 0 ? groups : undefined;
}

/**
 * Project a claimed sandbox row's agent_config (+ agent_name fallback) into a
 * payload the container's strict `PUT /api/character` accepts. Null ⇒ nothing
 * to push (no name available at all).
 */
export function buildWarmClaimCharacterPayload(
  agentConfig: unknown,
  agentName?: string | null,
): Record<string, unknown> | null {
  const config =
    agentConfig && typeof agentConfig === "object" && !Array.isArray(agentConfig)
      ? (agentConfig as Record<string, unknown>)
      : {};

  const name =
    typeof config.name === "string" && config.name.trim()
      ? config.name.trim()
      : (agentName?.trim() ?? "");
  if (!name) return null;

  const payload: Record<string, unknown> = { name: toWellFormedUnicode(name) };

  if (typeof config.username === "string" && config.username.trim()) {
    payload.username = toWellFormedUnicode(config.username.trim());
  }
  if (typeof config.system === "string" && config.system.trim()) {
    payload.system = toWellFormedUnicode(config.system);
  }

  const bio =
    typeof config.bio === "string" && config.bio.trim()
      ? [toWellFormedUnicode(config.bio)]
      : cleanStringArray(config.bio);
  if (bio) payload.bio = bio;

  const adjectives = cleanStringArray(config.adjectives);
  if (adjectives) payload.adjectives = adjectives;

  const topics = cleanStringArray(config.topics);
  if (topics) payload.topics = topics;

  if (config.style && typeof config.style === "object" && !Array.isArray(config.style)) {
    const rawStyle = config.style as Record<string, unknown>;
    const style: Record<string, string[]> = {};
    for (const key of ["all", "chat", "post"] as const) {
      const items = cleanStringArray(rawStyle[key]);
      if (items) style[key] = items;
    }
    if (Object.keys(style).length > 0) payload.style = style;
  }

  const postExamples = cleanStringArray(config.postExamples);
  if (postExamples) payload.postExamples = postExamples;

  const messageExamples = sanitizeMessageExampleGroups(config.messageExamples);
  if (messageExamples) payload.messageExamples = messageExamples;

  return payload;
}
