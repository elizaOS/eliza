/**
 * Proactive-interaction UX governance gate (#8792).
 *
 * The "not annoying" core: turns a stream of UI interactions (view switches,
 * slash commands, shortcuts) into AT MOST a trickle of proactive comments. Pure
 * and deterministic — `now` is injected, all state is in-memory — so every rule
 * (kill-switch, global cooldown, per-surface cooldown, daily cap, textual dedup,
 * burst debounce) is unit-testable without a runtime or a clock.
 *
 * It does NOT decide WHAT to say (that's the model judge) — only WHETHER a
 * comment is allowed right now. The decider calls {@link tryAdmit} after the
 * model produced a candidate comment; an admitted call also records the emission
 * so subsequent calls respect the caps.
 */

/** How talkative proactive interaction-comments are. */
export type ProactiveChattiness = "off" | "subtle" | "chatty";

export interface ProactiveGateConfig {
  /** Master verbosity. `off` disables all proactive interaction comments. */
  chattiness: ProactiveChattiness;
  /** Minimum gap between ANY two proactive comments. */
  globalCooldownMs: number;
  /** Minimum gap before re-commenting on the SAME surface. */
  perSurfaceCooldownMs: number;
  /** Hard cap on proactive comments in a rolling 24h window. */
  dailyCap: number;
  /** Suppress a comment textually identical to a recent one within this window. */
  dedupWindowMs: number;
  /** A surface must be "settled" (no newer switch) this long before commenting. */
  debounceMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_GLOBAL_COOLDOWN_KEY =
  "ELIZA_PROACTIVE_INTERACTIONS_TEST_COOLDOWN_MS";

/** Tuning per chattiness level. `subtle` is the recommended default for new users. */
export function configForChattiness(
  chattiness: ProactiveChattiness,
): ProactiveGateConfig {
  switch (chattiness) {
    case "off":
      return {
        chattiness,
        globalCooldownMs: Number.POSITIVE_INFINITY,
        perSurfaceCooldownMs: Number.POSITIVE_INFINITY,
        dailyCap: 0,
        dedupWindowMs: DAY_MS,
        debounceMs: 1_500,
      };
    case "chatty":
      return {
        chattiness,
        globalCooldownMs: 60_000,
        perSurfaceCooldownMs: 3 * 60_000,
        dailyCap: 40,
        dedupWindowMs: 15 * 60_000,
        debounceMs: 1_000,
      };
    default:
      return {
        chattiness: "subtle",
        globalCooldownMs: 2 * 60_000,
        perSurfaceCooldownMs: 10 * 60_000,
        dailyCap: 12,
        dedupWindowMs: 30 * 60_000,
        debounceMs: 1_500,
      };
  }
}

export const DEFAULT_PROACTIVE_GATE_CONFIG: ProactiveGateConfig =
  configForChattiness("subtle");

/** Read the kill-switch + chattiness setting from env / user setting. */
export function resolveProactiveChattiness(
  env: Record<string, string | undefined> = process.env,
  userSetting?: string | null,
): ProactiveChattiness {
  // Hard kill-switch mirrors the LifeOps proactive worker's env flag.
  const disabled = env.ELIZA_DISABLE_PROACTIVE_AGENT;
  if (disabled === "1" || disabled === "true" || disabled === "yes") {
    return "off";
  }
  const raw = (
    userSetting ??
    env.ELIZA_PROACTIVE_INTERACTIONS ??
    ""
  ).toLowerCase();
  if (raw === "off" || raw === "subtle" || raw === "chatty") return raw;
  return "subtle";
}

export function resolveProactiveGateConfig(
  env: Record<string, string | undefined> = process.env,
  userSetting?: string | null,
): ProactiveGateConfig {
  const config = configForChattiness(
    resolveProactiveChattiness(env, userSetting),
  );
  const testCooldownMs = parsePositiveMs(env[TEST_GLOBAL_COOLDOWN_KEY]);
  if (testCooldownMs === null || config.chattiness === "off") return config;
  return { ...config, globalCooldownMs: testCooldownMs };
}

function parsePositiveMs(raw: string | undefined): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

export interface AdmitInput {
  /** Surface key the comment is about (e.g. a view id). */
  surface: string;
  /** The candidate comment text (for dedup). */
  text: string;
  now: number;
}

export interface AdmitResult {
  admitted: boolean;
  reason: string;
}

interface EmissionRecord {
  surface: string;
  text: string;
  at: number;
}

interface SwitchRecord {
  surface: string;
  at: number;
}

/** In-memory, per-process governance state. */
export class ProactiveInteractionGate {
  private config: ProactiveGateConfig;
  private emissions: EmissionRecord[] = [];
  /** Latest switch time per surface, for the debounce/settle check. */
  private lastSwitchAt = new Map<string, number>();
  /** Most recent switch globally; older surfaces are no longer the settled one. */
  private latestSwitch: SwitchRecord | null = null;

  constructor(config: ProactiveGateConfig = DEFAULT_PROACTIVE_GATE_CONFIG) {
    this.config = config;
  }

  setConfig(config: ProactiveGateConfig): void {
    this.config = config;
  }

  /** Record that a surface switch happened (resets its settle timer). */
  noteSwitch(surface: string, now: number): void {
    this.lastSwitchAt.set(surface, now);
    this.latestSwitch = { surface, at: now };
  }

  /** True once `debounceMs` has elapsed since the last switch to `surface`. */
  isSettled(surface: string, now: number): boolean {
    if (this.latestSwitch && this.latestSwitch.surface !== surface) {
      return false;
    }
    const at = this.lastSwitchAt.get(surface);
    if (at === undefined) return true;
    return now - at >= this.config.debounceMs;
  }

  private pruneOlderThan(now: number): void {
    const cutoff = now - Math.max(DAY_MS, this.config.dedupWindowMs);
    if (this.emissions.length === 0) return;
    this.emissions = this.emissions.filter((e) => e.at >= cutoff);
  }

  /**
   * Evaluate every text-INDEPENDENT gate (disabled, settle, daily cap, global
   * cooldown, per-surface cooldown) without touching the candidate text and
   * without recording anything. Returns the first failing reason, or `"ok"`
   * when the surface would currently be admitted pending only textual dedup.
   *
   * Callers use this as a cheap precheck BEFORE soliciting the (paid) model
   * judge: if the gate would deny on a text-independent rule, there is no point
   * spending a judge call whose output {@link tryAdmit} would discard
   * unconditionally (#14678). It never mutates gate state, so a real admission
   * still goes through {@link tryAdmit}.
   */
  wouldAdmit(surface: string, now: number): AdmitResult {
    this.pruneOlderThan(now);
    return this.checkTextIndependentGates(surface, now);
  }

  /**
   * The text-independent portion of the admission gate. Shared by
   * {@link wouldAdmit} (precheck) and {@link tryAdmit} (commit) so the two can
   * never drift. Assumes {@link pruneOlderThan} has already run.
   */
  private checkTextIndependentGates(surface: string, now: number): AdmitResult {
    if (this.config.chattiness === "off" || this.config.dailyCap <= 0) {
      return { admitted: false, reason: "disabled" };
    }
    if (!this.isSettled(surface, now)) {
      return { admitted: false, reason: "debounce: surface not settled" };
    }
    // Daily cap.
    const inDay = this.emissions.filter((e) => now - e.at < DAY_MS).length;
    if (inDay >= this.config.dailyCap) {
      return { admitted: false, reason: "daily cap reached" };
    }
    // Global cooldown.
    const last = this.emissions.at(-1);
    if (last && now - last.at < this.config.globalCooldownMs) {
      return { admitted: false, reason: "global cooldown" };
    }
    // Per-surface cooldown.
    const lastForSurface = [...this.emissions]
      .reverse()
      .find((e) => e.surface === surface);
    if (
      lastForSurface &&
      now - lastForSurface.at < this.config.perSurfaceCooldownMs
    ) {
      return { admitted: false, reason: "per-surface cooldown" };
    }
    return { admitted: true, reason: "ok" };
  }

  /**
   * Check every gate and, when all pass, record the emission. Returns the first
   * failing reason so callers can log why a comment was suppressed.
   */
  tryAdmit(input: AdmitInput): AdmitResult {
    const { surface, text, now } = input;
    this.pruneOlderThan(now);

    const textIndependent = this.checkTextIndependentGates(surface, now);
    if (!textIndependent.admitted) {
      return textIndependent;
    }
    // Textual dedup (same surface + same text within the window).
    const normalized = text.trim().toLowerCase();
    const dup = this.emissions.find(
      (e) =>
        e.surface === surface &&
        e.text.trim().toLowerCase() === normalized &&
        now - e.at < this.config.dedupWindowMs,
    );
    if (dup) {
      return { admitted: false, reason: "duplicate of a recent comment" };
    }

    this.emissions.push({ surface, text, at: now });
    return { admitted: true, reason: "ok" };
  }

  reset(): void {
    this.emissions = [];
    this.lastSwitchAt.clear();
    this.latestSwitch = null;
  }
}
