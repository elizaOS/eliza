/**
 * Self-Awareness System v1 — shared contracts.
 *
 * @architecture Layered lazy-load + declarative AwarenessContributor
 * @see docs/plans/2026-03-01-self-awareness-design.md
 */
import type { IAgentRuntime } from "@elizaos/core";

export const SELF_STATUS_SCHEMA_VERSION = 1;

/** @deprecated Awareness summaries are no longer character-limited. */
export const SUMMARY_CHAR_LIMIT = 80;

/** @deprecated Awareness summaries are no longer character-limited. */
export const SUMMARY_TOTAL_CHAR_LIMIT = 1200;

/** Default cache TTL in ms (1 minute). */
export const DEFAULT_CACHE_TTL_MS = 60_000;

export type AwarenessInvalidationEvent =
  | "permission-changed"
  | "plugin-changed"
  | "wallet-updated"
  | "provider-changed"
  | "config-changed"
  | "runtime-restarted"
  | "opinion-updated";

export interface AwarenessContributor {
  /** Unique identifier, e.g. "wallet", "permissions". */
  id: string;

  /** Sort priority (lower = higher in output).
   *  10=runtime, 20=permissions, 30=wallet, 40=provider,
   *  50=pluginHealth, 60=connectors, 70=cloud, 80=features */
  position: number;

  /** Layer 1 summary — injected every LLM turn.
   *  MUST return plain text, never secrets/keys/tokens.
   *  Return "" if nothing should be shown. */
  summary: (runtime: IAgentRuntime) => Promise<string>;

  /** Layer 2 detail — called via RUNTIME action with op=self_status.
   *  "brief" ~= 200 tokens, "full" ~= 2000 tokens. */
  detail?: (runtime: IAgentRuntime, level: "brief" | "full") => Promise<string>;

  /** Cache TTL in ms. Default DEFAULT_CACHE_TTL_MS. */
  cacheTtl?: number;

  /** Events that proactively clear the cache (don't wait for TTL). */
  invalidateOn?: AwarenessInvalidationEvent[];

  /** Only built-in contributors set trusted=true.
   *  Untrusted contributor output is sanitized before injection. */
  trusted?: boolean;
}
