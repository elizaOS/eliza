/**
 * Coding-backend routing — resolves WHICH coding sub-agent backend (claude /
 * codex / opencode / elizaos / pi-agent) handles a spawn, from explicit user
 * intent, declared character policy, operator pin, and the planner's guess.
 *
 * This replaces the old "operator pin always wins, planner's per-task choice is
 * silently discarded" behaviour at the spawn chokepoints. The pin is demoted to
 * one input among several with a defined precedence:
 *
 *   1. explicit   — the user named a backend THIS turn (a `framework:` prefix in
 *                   the task text, or the planner's `requestedBackend` field,
 *                   which it only fills when the user explicitly asked).
 *   2. character  — the agent author DECLARED routing in
 *                   `character.settings.routing.coding` — `byTag[tag]` first
 *                   (an opaque difficulty tag the planner emits), then `default`.
 *   3. pin        — the operator's `ELIZA_ACP_DEFAULT_AGENT` deployment default.
 *   4. planner    — the planner's heuristic `agentType` guess (kept last because
 *                   it routinely guesses from context tokens — the reason the pin
 *                   historically overrode it).
 *
 * Selection is identity-only: it returns a backend id, never a credential.
 * Credential materialization stays in the account/provider substrate. There is
 * NO inspection of message text here — `explicit` is a structurally-extracted
 * field (a validated `requestedBackend` or `framework:` prefix, resolved by the
 * caller), and difficulty arrives as an opaque model-emitted tag, so routing
 * stays general, not a keyword heuristic.
 *
 * @module services/coding-backend-routing
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";
import {
  KNOWN_ADAPTER_TYPES,
  normalizeTaskAgentAdapter,
  resolvePinnedAdapter,
} from "./task-agent-routing.js";

/** Routing policy for the coding sub-agent backend axis. */
export interface BackendAxisRouting {
  /** Backend chosen when no tag matches and nothing more specific applies. */
  default?: string;
  /** Map an opaque routing tag (e.g. "simple" / "hard") to a backend id. */
  byTag?: Record<string, string>;
  /**
   * Optional operator lock-list. When set, ANY resolved backend (explicit,
   * byTag, default, pin, or planner) must be a member or it is rejected and
   * resolution falls through to the caller's own default. Unset = no
   * restriction (every known backend is allowed). This is how an operator
   * confines a deployment to a subset of backends even though an explicit user
   * request can otherwise override the pin.
   */
  allow?: string[];
}

/** Where a resolved backend came from — surfaced in logs/trajectories. */
export type CodingBackendSource =
  | "explicit"
  | "character:byTag"
  | "character:default"
  | "env:byTag"
  | "env:default"
  | "pin"
  | "planner";

export interface CodingBackendResolution {
  agentType: string;
  source: CodingBackendSource;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce an unknown into a valid `BackendAxisRouting`, dropping bad fields. */
function parseAxis(value: unknown): BackendAxisRouting | undefined {
  if (!isPlainObject(value)) return undefined;
  const axis: BackendAxisRouting = {};
  if (typeof value.default === "string") axis.default = value.default;
  if (isPlainObject(value.byTag)) {
    const byTag: Record<string, string> = {};
    for (const [tag, backend] of Object.entries(value.byTag)) {
      if (typeof backend === "string") byTag[tag.toLowerCase()] = backend;
    }
    if (Object.keys(byTag).length > 0) axis.byTag = byTag;
  }
  if (Array.isArray(value.allow)) {
    const allow = value.allow.filter((v): v is string => typeof v === "string");
    axis.allow = allow;
  }
  return axis.default || axis.byTag || axis.allow ? axis : undefined;
}

/** Pull the `coding` axis out of a routing object (`{ coding: {...} }`). */
function parseCodingAxis(raw: unknown): BackendAxisRouting | undefined {
  if (!isPlainObject(raw)) return undefined;
  return parseAxis(raw.coding);
}

/**
 * Resolve the coding routing axis from, in order: the character's declared
 * `settings.routing.coding`, then the `ELIZA_BACKEND_ROUTING` config-env JSON's
 * `coding` axis (the same structured-config mechanism `TASK_AGENT_WORKDIR_ROUTES`
 * uses — a deployment-level override that works even when the character builder
 * does not forward arbitrary `settings` keys). Resolved PER AXIS: a character
 * that declares unrelated routing keys does not shadow an env-declared coding
 * policy. Both sources are validated; this is declared policy, never
 * message-text inspection.
 */
function readCodingRoutingEntry(
  runtime: IAgentRuntime | undefined,
): { routing: BackendAxisRouting; source: "character" | "env" } | undefined {
  const fromCharacter = parseCodingAxis(runtime?.character?.settings?.routing);
  if (fromCharacter) {
    return { routing: fromCharacter, source: "character" };
  }

  const rawEnv = readConfigEnvKey("ELIZA_BACKEND_ROUTING")?.trim();
  if (!rawEnv) return undefined;
  try {
    const fromEnv = parseCodingAxis(JSON.parse(rawEnv));
    return fromEnv ? { routing: fromEnv, source: "env" } : undefined;
  } catch (err) {
    logger.warn(
      `[backend-routing] failed to parse ELIZA_BACKEND_ROUTING: ${
        (err as Error).message
      }`,
    );
    return undefined;
  }
}

export function readCodingRouting(
  runtime: IAgentRuntime | undefined,
): BackendAxisRouting | undefined {
  return readCodingRoutingEntry(runtime)?.routing;
}

/** Normalize a candidate to a known adapter id, or `undefined` if unusable. */
function asKnownAdapter(value: string | undefined): string | undefined {
  const normalized = normalizeTaskAgentAdapter(value);
  return normalized && KNOWN_ADAPTER_TYPES.has(normalized)
    ? normalized
    : undefined;
}

/**
 * Resolve the coding backend for a spawn. Returns `undefined` only when nothing
 * applies (no explicit ask, no declared policy, no pin, no usable planner
 * guess) — the caller then falls back to its dynamic resolver / hard default.
 *
 * When the operator declares an `allow` lock-list, every candidate (including an
 * explicit user ask) is constrained to it; a disallowed candidate is skipped so
 * resolution continues down the precedence chain instead of escaping the lock.
 */
export function resolveCodingBackend(args: {
  runtime: IAgentRuntime | undefined;
  /** Backend the user named THIS turn (framework prefix or `requestedBackend`). */
  explicit?: string;
  /** Opaque difficulty tag the planner emitted (keys `routing.coding.byTag`). */
  tag?: string;
  /** The planner's heuristic `agentType` guess (lowest precedence). */
  plannerGuess?: string;
}): CodingBackendResolution | undefined {
  const codingEntry = readCodingRoutingEntry(args.runtime);
  const coding = codingEntry?.routing;
  const rawAllow = coding?.allow;
  const allowConfigured = Array.isArray(rawAllow);
  const allow = allowConfigured
    ? rawAllow
        .map((v) => asKnownAdapter(v))
        .filter((v): v is string => Boolean(v))
    : undefined;
  const allowed = (backend: string | undefined): string | undefined =>
    backend && (!allowConfigured || allow?.includes(backend))
      ? backend
      : undefined;

  const explicit = allowed(asKnownAdapter(args.explicit));
  if (explicit) return { agentType: explicit, source: "explicit" };

  if (coding) {
    const tag = args.tag?.trim().toLowerCase();
    if (tag && coding.byTag) {
      const byTag = allowed(asKnownAdapter(coding.byTag[tag]));
      if (byTag) {
        return {
          agentType: byTag,
          source: `${codingEntry.source}:byTag` as CodingBackendSource,
        };
      }
    }
    const fallback = allowed(asKnownAdapter(coding.default));
    if (fallback) {
      return {
        agentType: fallback,
        source: `${codingEntry.source}:default` as CodingBackendSource,
      };
    }
  }

  const pin = allowed(resolvePinnedAdapter(args.runtime));
  if (pin) return { agentType: pin, source: "pin" };

  const guess = allowed(asKnownAdapter(args.plannerGuess));
  if (guess) return { agentType: guess, source: "planner" };

  return undefined;
}

/** Resolve + log the routing decision in one step (keeps spawn callers terse). */
export function resolveCodingBackendLogged(args: {
  runtime: IAgentRuntime | undefined;
  explicit?: string;
  tag?: string;
  plannerGuess?: string;
}): CodingBackendResolution | undefined {
  const resolved = resolveCodingBackend(args);
  if (resolved) {
    // Only surface the tag when it actually drove the decision (byTag); on any
    // other source the tag was an unused input and printing it misreads in
    // trajectories as if difficulty influenced routing.
    const tagSuffix =
      resolved.source === "character:byTag" && args.tag
        ? `, tag=${args.tag}`
        : "";
    logger.info(
      `[backend-routing] coding → ${resolved.agentType} (${resolved.source}${tagSuffix})`,
    );
  }
  return resolved;
}
