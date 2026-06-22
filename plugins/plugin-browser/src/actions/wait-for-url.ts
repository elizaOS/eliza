/**
 * BROWSER `wait_for_url` subaction core.
 *
 * Opens (or reuses) a tab, then polls the current tab URL until it matches a
 * caller-supplied pattern (substring or regex — see
 * {@link buildWaitForUrlPredicate}) or a deadline passes. Each poll iteration
 * emits a streaming status update through the action's `HandlerCallback` so a
 * Telegram/chat user sees progress; the loop never throws on timeout — it
 * returns a typed {@link WaitForUrlOutcome}.
 *
 * The poll loop takes its URL source, clock, and sleep as injected
 * dependencies so it is fully deterministic under test (fake URL source + fake
 * timer) with no real browser.
 */

import { buildWaitForUrlPredicate } from "./wait-for-url-predicate.js";

/** Default deadline: 5 minutes. */
export const WAIT_FOR_URL_DEFAULT_TIMEOUT_MS = 300_000;
/** Default poll cadence: ~2 seconds. */
export const WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Lower bound for the poll interval (avoids a hot loop). */
const WAIT_FOR_URL_MIN_POLL_INTERVAL_MS = 50;
/** Lower bound for the timeout (always allow at least one poll). */
const WAIT_FOR_URL_MIN_TIMEOUT_MS = 1;

export type WaitForUrlStatus = "matched" | "timeout";

export interface WaitForUrlOutcome {
  status: WaitForUrlStatus;
  /** True iff the URL matched before the deadline. */
  matched: boolean;
  /** The pattern the caller supplied. */
  pattern: string;
  /** The last URL observed from the tab (null if never readable). */
  lastUrl: string | null;
  /** Number of poll iterations performed. */
  polls: number;
  /** Wall-clock elapsed time, in ms, measured from the injected clock. */
  elapsedMs: number;
  /** Human-readable summary suitable for a chat reply. */
  message: string;
}

export interface WaitForUrlOptions {
  /** Substring or regex to match against the current tab URL. */
  pattern: string;
  /** Deadline in ms. Defaults to {@link WAIT_FOR_URL_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Poll cadence in ms. Defaults to
   * {@link WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS}.
   */
  pollIntervalMs?: number;
}

export interface WaitForUrlDeps {
  /**
   * Reads the current tab URL. Returns null when the URL is not yet readable
   * (e.g. tab still loading); the loop keeps polling until the deadline.
   */
  getCurrentUrl: () => Promise<string | null> | string | null;
  /** Emits a status update to the user. Optional (may be a no-op). */
  emitStatus?: (text: string) => Promise<void> | void;
  /** Monotonic clock in ms. Defaults to `Date.now`. */
  now?: () => number;
  /** Async sleep. Defaults to a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clampPollInterval(value: number | undefined): number {
  const candidate = value ?? WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(WAIT_FOR_URL_MIN_POLL_INTERVAL_MS, Math.floor(candidate));
}

function clampTimeout(value: number | undefined): number {
  const candidate = value ?? WAIT_FOR_URL_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return WAIT_FOR_URL_DEFAULT_TIMEOUT_MS;
  }
  return Math.max(WAIT_FOR_URL_MIN_TIMEOUT_MS, Math.floor(candidate));
}

function describeCurrentUrl(url: string | null): string {
  return url ? `current: ${url}` : "current: unknown";
}

/**
 * Poll the current tab URL until it matches `pattern` or the deadline passes.
 * Never throws on timeout — returns a typed {@link WaitForUrlOutcome}.
 */
export async function waitForUrl(
  options: WaitForUrlOptions,
  deps: WaitForUrlDeps,
): Promise<WaitForUrlOutcome> {
  const predicate = buildWaitForUrlPredicate(options.pattern);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const pollIntervalMs = clampPollInterval(options.pollIntervalMs);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;

  const startedAt = now();
  const deadline = startedAt + timeoutMs;

  let polls = 0;
  let lastUrl: string | null = null;

  while (true) {
    polls += 1;

    let currentUrl: string | null = null;
    try {
      currentUrl = (await deps.getCurrentUrl()) ?? null;
    } catch {
      // Treat an unreadable URL like an empty poll; keep waiting.
      currentUrl = null;
    }
    if (currentUrl !== null) {
      lastUrl = currentUrl;
    }

    if (currentUrl !== null && predicate.test(currentUrl)) {
      const elapsedMs = now() - startedAt;
      const message = `Done — tab reached ${currentUrl} (matched ${predicate.kind} "${predicate.pattern}" after ${polls} check${polls === 1 ? "" : "s"}).`;
      await deps.emitStatus?.(`✅ ${message}`);
      return {
        status: "matched",
        matched: true,
        pattern: predicate.pattern,
        lastUrl,
        polls,
        elapsedMs,
        message,
      };
    }

    const elapsedMs = now() - startedAt;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      const message = `Timed out after ${Math.round(elapsedMs / 1000)}s waiting for "${predicate.pattern}" (${describeCurrentUrl(lastUrl)}).`;
      await deps.emitStatus?.(`⌛ ${message}`);
      return {
        status: "timeout",
        matched: false,
        pattern: predicate.pattern,
        lastUrl,
        polls,
        elapsedMs,
        message,
      };
    }

    await deps.emitStatus?.(
      `⏳ still waiting for "${predicate.pattern}"… (${describeCurrentUrl(currentUrl)})`,
    );

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}
