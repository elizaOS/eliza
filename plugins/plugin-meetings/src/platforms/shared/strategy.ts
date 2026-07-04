/**
 * Per-platform strategy contract driven by the shared meeting flow
 * (meeting-flow.ts). Faithful port of Vexa's PlatformStrategies shape
 * (services/vexa-bot/core/src/platforms/shared/meetingFlow.ts) — one strategy
 * object per platform, no platform branching inside the flow.
 */

import type { MeetingEndReason } from "@elizaos/shared";
import type { Page } from "playwright-core";
import type { MeetingBotSession } from "../../types.js";

/** Outcome of an admission wait. */
export type AdmissionOutcome = "admitted" | "rejected" | "timeout";

/**
 * Platform-specific steps the shared flow orchestrates. Every method receives
 * the Playwright page for the bot's tab plus the session (config, sink,
 * abort signal, status reporting).
 */
export interface PlatformStrategies {
  /** Navigate + fill the pre-join form + request to join (guest join). */
  join(page: Page, session: MeetingBotSession): Promise<void>;
  /**
   * Wait until admitted, rejected, or timed out (waiting room / lobby).
   * Must tolerate reCAPTCHA-style challenges by continuing to wait rather
   * than misclassifying them as rejection.
   */
  waitForAdmission(
    page: Page,
    session: MeetingBotSession,
    timeoutMs: number,
  ): Promise<AdmissionOutcome>;
  /** Cheap non-blocking admission check used while `prepare` runs in parallel. */
  checkAdmissionSilent(page: Page): Promise<boolean>;
  /** Post-admission setup that can run before recording (mute checks, UI prep). */
  prepare(page: Page, session: MeetingBotSession): Promise<void>;
  /**
   * Start audio capture + speaker attribution, pushing into `session.sink`.
   * Resolves when the meeting ends naturally (everyone left / alone timeout);
   * the shared flow races this against the removal monitor and the abort
   * signal.
   */
  startRecording(
    page: Page,
    session: MeetingBotSession,
  ): Promise<MeetingEndReason>;
  /**
   * Resolve when the bot is removed by an admin (or the page is closed under
   * it). Never resolves for the normal path.
   */
  startRemovalMonitor(
    page: Page,
    session: MeetingBotSession,
  ): Promise<MeetingEndReason>;
  /** Click the platform's leave control; best-effort, must not throw. */
  leave(page: Page): Promise<void>;
}
