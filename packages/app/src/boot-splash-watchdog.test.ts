import { afterEach, describe, expect, it } from "vitest";
import {
  BOOT_SPLASH_SELECTOR,
  BOOT_STUCK_OVERLAY_ID,
  type BootSplashWatchdog,
  DEFAULT_BOOT_PHASE_DEADLINES_MS,
  DEFAULT_BOOT_STUCK_DEADLINE_MS,
  deadlineForPhase,
  startBootSplashWatchdog,
} from "./boot-splash-watchdog";

let active: BootSplashWatchdog | null = null;

function mountSplash(phase: string): HTMLElement {
  const splash = document.createElement("div");
  splash.setAttribute("data-testid", "startup-shell-loading");
  splash.setAttribute("data-startup-phase", phase);
  document.body.appendChild(splash);
  return splash;
}

function overlay(): HTMLElement | null {
  return document.getElementById(BOOT_STUCK_OVERLAY_ID);
}

function makeWatchdog(
  clock: { now: number },
  extra: Parameters<typeof startBootSplashWatchdog>[0] = {},
): BootSplashWatchdog {
  active = startBootSplashWatchdog({
    doc: document,
    now: () => clock.now,
    schedule: false,
    ...extra,
  });
  return active;
}

afterEach(() => {
  active?.dispose();
  active = null;
  document.body.innerHTML = "";
});

describe("deadlineForPhase", () => {
  it("uses the long deadline for runtime/hydration phases and the default elsewhere", () => {
    expect(
      deadlineForPhase(
        "starting-runtime",
        DEFAULT_BOOT_PHASE_DEADLINES_MS,
        DEFAULT_BOOT_STUCK_DEADLINE_MS,
      ),
    ).toBe(300_000);
    expect(
      deadlineForPhase(
        "polling-backend",
        DEFAULT_BOOT_PHASE_DEADLINES_MS,
        DEFAULT_BOOT_STUCK_DEADLINE_MS,
      ),
    ).toBe(90_000);
  });
});

describe("startBootSplashWatchdog", () => {
  it("shows the stuck overlay after the deadline in one unchanged phase", () => {
    const clock = { now: 0 };
    mountSplash("polling-backend");
    const stuckPhases: string[] = [];
    const watchdog = makeWatchdog(clock, {
      onStuck: (phase) => stuckPhases.push(phase),
    });

    watchdog.tick();
    expect(overlay()).toBeNull();

    clock.now = 89_999;
    watchdog.tick();
    expect(overlay()).toBeNull();

    clock.now = 90_001;
    watchdog.tick();
    const el = overlay();
    expect(el).not.toBeNull();
    expect(el?.getAttribute("data-boot-stuck-phase")).toBe("polling-backend");
    expect(el?.textContent).toContain("phase: polling-backend");
    expect(stuckPhases).toEqual(["polling-backend"]);

    // Stays a single overlay on further ticks.
    clock.now = 200_000;
    watchdog.tick();
    expect(document.querySelectorAll(`#${BOOT_STUCK_OVERLAY_ID}`)).toHaveLength(
      1,
    );
  });

  it("resets the clock when the phase progresses", () => {
    const clock = { now: 0 };
    const splash = mountSplash("restoring-session");
    const watchdog = makeWatchdog(clock);

    watchdog.tick();
    clock.now = 80_000;
    watchdog.tick();
    expect(overlay()).toBeNull();

    // Progress to a new phase just before the old deadline: timer restarts.
    splash.setAttribute("data-startup-phase", "polling-backend");
    watchdog.tick();
    clock.now = 160_000;
    watchdog.tick();
    expect(overlay()).toBeNull();

    clock.now = 171_000;
    watchdog.tick();
    expect(overlay()).not.toBeNull();
  });

  it("uses the long deadline for starting-runtime so slow on-device agent boots never false-fire", () => {
    const clock = { now: 0 };
    mountSplash("starting-runtime");
    const watchdog = makeWatchdog(clock);

    watchdog.tick();
    clock.now = 299_000;
    watchdog.tick();
    expect(overlay()).toBeNull();

    clock.now = 301_000;
    watchdog.tick();
    expect(overlay()).not.toBeNull();
  });

  it("clears the overlay when the splash unmounts (boot progressed)", () => {
    const clock = { now: 0 };
    const splash = mountSplash("polling-backend");
    const watchdog = makeWatchdog(clock);

    watchdog.tick();
    clock.now = 100_000;
    watchdog.tick();
    expect(overlay()).not.toBeNull();

    splash.remove();
    watchdog.tick();
    expect(overlay()).toBeNull();
  });

  it("never fires while no splash is mounted", () => {
    const clock = { now: 0 };
    const watchdog = makeWatchdog(clock);
    watchdog.tick();
    clock.now = 10_000_000;
    watchdog.tick();
    expect(overlay()).toBeNull();
  });

  it("Retry invokes the retry action", () => {
    const clock = { now: 0 };
    mountSplash("polling-backend");
    let retried = 0;
    const watchdog = makeWatchdog(clock, { onRetry: () => retried++ });

    watchdog.tick();
    clock.now = 100_000;
    watchdog.tick();
    (
      document.querySelector('[data-testid="boot-stuck-retry"]') as HTMLElement
    ).click();
    expect(retried).toBe(1);
  });

  it("Keep waiting dismisses the overlay and re-arms the deadline", () => {
    const clock = { now: 0 };
    mountSplash("polling-backend");
    const watchdog = makeWatchdog(clock);

    watchdog.tick();
    clock.now = 100_000;
    watchdog.tick();
    expect(overlay()).not.toBeNull();

    (
      document.querySelector('[data-testid="boot-stuck-wait"]') as HTMLElement
    ).click();
    expect(overlay()).toBeNull();

    // Not yet past the re-armed deadline.
    clock.now = 189_000;
    watchdog.tick();
    expect(overlay()).toBeNull();

    // Past it again: overlay returns.
    clock.now = 191_000;
    watchdog.tick();
    expect(overlay()).not.toBeNull();
  });

  it("dispose removes the overlay and stops future ticks", () => {
    const clock = { now: 0 };
    mountSplash("polling-backend");
    const watchdog = makeWatchdog(clock);

    watchdog.tick();
    clock.now = 100_000;
    watchdog.tick();
    expect(overlay()).not.toBeNull();

    watchdog.dispose();
    expect(overlay()).toBeNull();
    clock.now = 500_000;
    watchdog.tick();
    expect(overlay()).toBeNull();
  });

  it("exports the selector the startup shell actually renders", () => {
    // Contract with @elizaos/ui StartupShell: keep in sync with
    // packages/ui/src/components/shell/StartupShell.tsx.
    expect(BOOT_SPLASH_SELECTOR).toBe('[data-testid="startup-shell-loading"]');
  });
});
