/**
 * Analysis mode (Westworld nod) — per-room debug flag.
 *
 * When a user types `analysis` in chat, that conversation flips into
 * analysis mode: subsequent assistant turns attach a structured debug
 * sidecar (thinking, planned actions, simple-mode flag, evaluator output,
 * followup decision) to the response. The user types `as you were` to
 * disable it.
 *
 * SCAFFOLD ONLY. The runtime has not yet been wired to consult this flag
 * or attach the sidecar. This module exists so the activation parsing,
 * lifetime, and gating logic are pinned down with tests before the
 * cross-cutting integration is written. See
 * `/tmp/lifeops-assessment/15-analysis-mode.md` for the full design.
 *
 * Privacy contract:
 *   - Analysis sidecars contain raw thinking, prompt fragments, evaluator
 *     output (facts/relationships about real people), and follow-up timing.
 *     They MUST NOT be forwarded to remote chat surfaces (Telegram,
 *     Discord, WeChat, etc.).
 *   - `isAnalysisModeAllowed()` returns false unless the runtime is local
 *     (loopback API) AND development mode is on, OR the operator opted in
 *     via `MILADY_ENABLE_ANALYSIS_MODE=1`.
 *
 * Storage:
 *   - In-memory `Map<roomId, AnalysisModeState>`. Process-local.
 *     Restarts clear the flag — that is intentional. Analysis mode is a
 *     transient debug toggle, not a persisted preference. If we later
 *     decide to persist it, write to `Room.metadata.analysisMode`, not
 *     to a new table.
 */

const ANALYSIS_TOKEN = /^\s*analysis\s*$/i;
const AS_YOU_WERE_TOKEN = /^\s*as\s+you\s+were\s*$/i;

export type AnalysisToken = "enable" | "disable" | null;

export interface AnalysisModeState {
  enabled: boolean;
  enabledAt: number;
  /** Optional cap so we never leave analysis on forever in a dev session. */
  expiresAt?: number;
}

export interface AnalysisModeOptions {
  /**
   * If set, analysis mode auto-disables this many ms after enable. Default:
   * undefined (no auto-expire). Suggest 1h (3_600_000) when wiring.
   */
  ttlMs?: number;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

/**
 * Detect activation tokens. Returns:
 *   - "enable"  for messages whose entire text is the literal `analysis`
 *   - "disable" for messages whose entire text is the literal `as you were`
 *   - null      otherwise
 *
 * The match is intentionally strict (whole-message, case-insensitive,
 * surrounding whitespace allowed) so normal conversation that mentions
 * "analysis" or "as you were" inside a sentence does not flip the flag.
 */
export function parseAnalysisToken(
  text: string | undefined | null,
): AnalysisToken {
  if (typeof text !== "string") return null;
  if (ANALYSIS_TOKEN.test(text)) return "enable";
  if (AS_YOU_WERE_TOKEN.test(text)) return "disable";
  return null;
}

/**
 * Per-room analysis-mode flag store. Process-local. One instance per
 * runtime is sufficient — the runtime should hold it as a singleton on
 * a known property (e.g. `runtime.analysisModeFlags`) once wired.
 */
export class AnalysisModeFlagStore {
  private readonly flags = new Map<string, AnalysisModeState>();
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  constructor(options: AnalysisModeOptions = {}) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  enable(roomId: string): AnalysisModeState {
    const enabledAt = this.now();
    const state: AnalysisModeState = {
      enabled: true,
      enabledAt,
      expiresAt:
        typeof this.ttlMs === "number" && this.ttlMs > 0
          ? enabledAt + this.ttlMs
          : undefined,
    };
    this.flags.set(roomId, state);
    return state;
  }

  disable(roomId: string): void {
    this.flags.delete(roomId);
  }

  /**
   * Read the current state. Returns false if disabled, never set, or
   * expired (and clears the entry on read in the expired case).
   */
  isEnabled(roomId: string): boolean {
    const state = this.flags.get(roomId);
    if (!state) return false;
    if (typeof state.expiresAt === "number" && state.expiresAt <= this.now()) {
      this.flags.delete(roomId);
      return false;
    }
    return state.enabled;
  }

  /** Apply a parsed token to the store. Returns the new enabled state. */
  applyToken(roomId: string, token: AnalysisToken): boolean {
    if (token === "enable") {
      this.enable(roomId);
      return true;
    }
    if (token === "disable") {
      this.disable(roomId);
      return false;
    }
    return this.isEnabled(roomId);
  }

  /** Test helper. */
  size(): number {
    return this.flags.size;
  }

  /** Test helper. */
  clear(): void {
    this.flags.clear();
  }
}

/**
 * Gate analysis-mode payload emission. Returns true only when:
 *   - the operator has explicitly opted in via env, OR
 *   - we are in NODE_ENV=development AND the source is loopback API.
 *
 * The runtime wiring (not yet implemented) MUST consult this before
 * attaching any sidecar. Sidecars contain raw thinking, evaluator
 * output, and prompt fragments — never forward to remote connectors.
 */
export function isAnalysisModeAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.MILADY_ENABLE_ANALYSIS_MODE === "1") return true;
  if (env.MILADY_ENABLE_ANALYSIS_MODE === "0") return false;
  return env.NODE_ENV === "development";
}
