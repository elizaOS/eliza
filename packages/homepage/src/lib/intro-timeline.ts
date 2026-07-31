/**
 * Installs the landing intro deadlines against an injectable clock.
 *
 * The active guard makes teardown deterministic even when a queued timeout
 * callback races with React unmounting the page.
 */

export const INTRO_TIMING_MS = {
  animationStart: 1000,
  introDone: 1680,
  showUi: 1800,
} as const;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

export interface IntroTimelineClock {
  setTimeout(callback: () => void, delayMs: number): TimeoutHandle;
  clearTimeout(handle: TimeoutHandle): void;
}

interface IntroTimelineCallbacks {
  onIntroDone(): void;
  onShowUi(): void;
}

const browserClock: IntroTimelineClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function installIntroTimeline(
  callbacks: IntroTimelineCallbacks,
  clock: IntroTimelineClock = browserClock,
): () => void {
  let active = true;
  const runWhileActive = (callback: () => void) => () => {
    if (active) callback();
  };
  const introDoneTimer = clock.setTimeout(
    runWhileActive(callbacks.onIntroDone),
    INTRO_TIMING_MS.introDone,
  );
  const showUiTimer = clock.setTimeout(
    runWhileActive(callbacks.onShowUi),
    INTRO_TIMING_MS.showUi,
  );

  return () => {
    active = false;
    clock.clearTimeout(introDoneTimer);
    clock.clearTimeout(showUiTimer);
  };
}
