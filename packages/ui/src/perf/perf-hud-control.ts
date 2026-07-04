/**
 * Enable affordance for the dev perf HUD + frame-budget telemetry (issue #9141).
 *
 * The frame-budget monitor + PerfOverlay self-gate on `window.__ELIZA_PERF_HUD__`
 * so they cost production nothing. This module is the single place that flips it:
 * - boot enable from a Vite env (`VITE_ELIZA_PERF_HUD`) or a persisted pref,
 * - a runtime hotkey (Cmd/Ctrl+Shift+P),
 * - a console handle (`window.__elizaPerfHud()`),
 * each dispatching PERF_TOGGLE_EVENT so live consumers react.
 *
 * Reflow + re-render telemetry gates separately on isRenderTelemetryEnabled().
 * Only the rAF-driven FPS/jank sampler is opt-in here, to honor the battery
 * decision that removed permanent rAF loops.
 */

import { isRenderTelemetryEnabled } from "../hooks/useRenderGuard";

/** Dispatched on `window` whenever the perf-HUD flag flips. */
export const PERF_TOGGLE_EVENT = "eliza:perf-toggle";

const PERSIST_KEY = "eliza:perf-hud";

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, boolean | string | undefined>;
};

interface PerfHudWindow extends Window {
  __ELIZA_PERF_HUD__?: boolean;
  __elizaPerfHud?: (enabled?: boolean) => boolean;
}

function perfWindow(): PerfHudWindow | undefined {
  return typeof window === "undefined" ? undefined : (window as PerfHudWindow);
}

/** Whether the perf-HUD opt-in flag is currently set. */
export function isPerfHudFlag(): boolean {
  return perfWindow()?.__ELIZA_PERF_HUD__ === true;
}

/** Set the perf-HUD flag, persist the choice, and notify live consumers. */
export function setPerfHud(enabled: boolean): void {
  const win = perfWindow();
  if (!win) return;
  win.__ELIZA_PERF_HUD__ = enabled;
  try {
    win.localStorage?.setItem(PERSIST_KEY, enabled ? "1" : "0");
  } catch {
    // private mode / storage disabled: the in-memory flag is still authoritative.
  }
  if (typeof Event === "function") {
    win.dispatchEvent(new Event(PERF_TOGGLE_EVENT));
  }
}

/** Flip the perf-HUD flag. Returns the new state. */
export function togglePerfHud(): boolean {
  const next = !isPerfHudFlag();
  setPerfHud(next);
  return next;
}

/**
 * Apply the boot-time opt-in: a Vite `VITE_ELIZA_PERF_HUD` define or a persisted
 * pref turns the HUD on at startup. No-op if already on or neither is set.
 */
export function bootPerfHud(): void {
  const win = perfWindow();
  if (!win || win.__ELIZA_PERF_HUD__ === true) return;
  const env = (import.meta as ImportMetaWithEnv).env;
  const envFlag = env?.VITE_ELIZA_PERF_HUD;
  let on = envFlag === "1" || envFlag === "true";
  if (!on) {
    try {
      on = win.localStorage?.getItem(PERSIST_KEY) === "1";
    } catch {
      on = false;
    }
  }
  if (on) setPerfHud(true);
}

/**
 * Install the dev affordances for toggling the HUD: a Cmd/Ctrl+Shift+P hotkey
 * and a `window.__elizaPerfHud([on])` console handle. Only attaches when render
 * telemetry is enabled (dev/test), so production adds no listener. Returns an
 * uninstaller.
 */
export function installPerfHudHotkey(): () => void {
  const win = perfWindow();
  if (!win || !isRenderTelemetryEnabled()) return () => {};

  win.__elizaPerfHud = (enabled?: boolean) => {
    const next = typeof enabled === "boolean" ? enabled : !isPerfHudFlag();
    setPerfHud(next);
    return next;
  };

  const onKey = (event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      (event.key === "P" || event.key === "p")
    ) {
      event.preventDefault();
      const on = togglePerfHud();
      console.info(
        `[PerfHUD] ${on ? "on" : "off"} - FPS/jank HUD + frame-budget telemetry (reflow + re-render telemetry stay on in dev)`,
      );
    }
  };
  win.addEventListener("keydown", onKey);
  return () => {
    win.removeEventListener("keydown", onKey);
    if (win.__elizaPerfHud) win.__elizaPerfHud = undefined;
  };
}
