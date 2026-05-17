/**
 * Transport-agnostic observer for the cloud onboarding orchestrator.
 *
 * `runCloudOnboarding` calls into this interface for every user-visible
 * event and every interactive prompt. CLI provides a `@clack/prompts`-
 * backed implementation; web/desktop provides an event-bridge
 * implementation; tests provide a capturing observer.
 *
 * The orchestrator MUST stay free of any presentation-layer concerns
 * (spinners, terminal output, GUI events). It only knows about the
 * methods defined here.
 *
 * @module cloud/onboarding-observer
 */
import type { ProvisionInfo } from "./bridge-client.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface AvailabilityResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

export interface ProvisionSuccessInfo {
  agentId: string;
  bridgeUrl?: string;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export interface ConfirmPrompt {
  message: string;
  /** Optional override for the default value when the user just presses enter. */
  defaultValue?: boolean;
  /** Optional label for the "true" branch. CLI surfaces use this on a toggle. */
  activeLabel?: string;
  /** Optional label for the "false" branch. CLI surfaces use this on a toggle. */
  inactiveLabel?: string;
}

export interface SelectChoiceOption<T extends string> {
  label: string;
  value: T;
  hint?: string;
}

export interface SelectChoicePrompt<T extends string> {
  message: string;
  options: SelectChoiceOption<T>[];
}

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

/**
 * Sink for every event the cloud onboarding orchestrator surfaces, plus the
 * interactive prompts it needs to resolve.
 *
 * Implementation contract:
 *
 *   - Event methods are fire-and-forget; they MUST NOT throw. Implementations
 *     that fail to render an event are responsible for their own logging.
 *   - Prompt methods are async. A `null` return from `selectChoice` or a
 *     cancellation from `confirm` is interpreted by the orchestrator as
 *     "user cancelled" — the orchestrator decides what that means for the
 *     flow. The observer MUST NOT exit the process or throw on cancel.
 */
export interface CloudOnboardingObserver {
  // ── Events ──────────────────────────────────────────────────────────────
  onAvailabilityChecked(result: AvailabilityResult): void;

  onAuthStart(loginUrl: string): void;
  /**
   * The orchestrator could not spawn the OS browser (no `open` / `xdg-open`
   * / `cmd.exe` on PATH, etc.). The login URL is unchanged — the observer
   * can render an inline "visit this URL manually" affordance, retry, or
   * surface the error however it wants. This was previously swallowed
   * silently behind a debug log.
   */
  onAuthBrowserOpenFailed(loginUrl: string, error: Error): void;
  onAuthPollStatus(status: string): void;
  onAuthSuccess(): void;
  onAuthFailure(message: string): void;

  onProvisionStart(agentName: string): void;
  onProvisionStatus(status: string, current?: ProvisionInfo): void;
  onProvisionTimeout(agentId: string, lastStatus: string): void;
  onProvisionFailure(reason: string): void;
  onProvisionSuccess(result: ProvisionSuccessInfo): void;

  /**
   * A categorized user-facing message that doesn't map onto a specific
   * lifecycle event — e.g. "Cloud login was not completed", "Cloud agent
   * is still starting up. You can try `eliza cloud connect` once it's
   * ready." The CLI implementation renders these as `log.warn`.
   */
  onNotice(message: string): void;

  /**
   * An unexpected, non-flow-control error. The orchestrator does not
   * itself swallow errors — it surfaces them here and lets the observer
   * decide whether to retry, fall back, or rethrow.
   */
  onFatalError(error: Error, context: string): void;

  // ── Prompts ─────────────────────────────────────────────────────────────
  /**
   * Resolve to `true` / `false` for a yes/no decision, or `null` when the
   * user explicitly cancels (e.g. Ctrl-C on CLI, modal dismiss on GUI).
   */
  confirm(prompt: ConfirmPrompt): Promise<boolean | null>;

  /**
   * Resolve to the chosen value, or `null` on cancel.
   */
  selectChoice<T extends string>(
    prompt: SelectChoicePrompt<T>,
  ): Promise<T | null>;
}
