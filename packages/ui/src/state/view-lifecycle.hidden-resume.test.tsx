// @vitest-environment jsdom
//
// Hidden keep-alive views must STAY paused across app-resume / tab refocus;
// only the ACTIVE view may wake on resume.
//
// A pausable keep-alive view's resting phase while hidden IS "paused" —
// `setActive` pauses it the moment another view becomes active (see the
// "retains + pauses a keep-alive view when hidden" case in
// view-lifecycle.test.tsx). `resumeAll` fires on APP_RESUME and on every
// `visibilitychange` back to visible; it must skip hidden retained records so
// their timers/polling/media (gated by `usePausableInterval` on `isPaused`)
// stay stopped. Concretely: open Calendar (keepAlive+pausable), go Home
// (calendar retained+paused, polling stopped), tab away and back — calendar
// must NOT restart while still hidden.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import {
  __resetViewLifecycleForTests,
  viewLifecycleController as ctrl,
  registerViewPolicy,
} from "./view-lifecycle";

beforeEach(() => {
  __resetViewLifecycleForTests();
});

afterEach(() => {
  __resetViewLifecycleForTests();
  // Drop any per-test visibilityState override so it can't leak.
  Reflect.deleteProperty(document, "visibilityState");
});

function setDocumentVisibility(state: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("hidden keep-alive views stay paused across resume signals", () => {
  it("APP_RESUME wakes only the active view; a hidden retained view stays paused", () => {
    ctrl.installSignals();
    registerViewPolicy("calendar", { keepAlive: true, pausable: true });
    ctrl.setActive("calendar");
    ctrl.setActive("settings");
    // Hidden keep-alive resting phase: paused (polling/timers stopped).
    expect(ctrl.getPhase("calendar")).toBe("paused");

    window.dispatchEvent(new Event(APP_PAUSE_EVENT));
    expect(ctrl.getPhase("settings")).toBe("paused");
    expect(ctrl.getPhase("calendar")).toBe("paused");

    window.dispatchEvent(new Event(APP_RESUME_EVENT));
    expect(ctrl.getPhase("settings")).toBe("active");
    // The hidden retained view must NOT wake — it is still hidden.
    expect(ctrl.getPhase("calendar")).toBe("paused");
  });

  it("a tab hide/refocus cycle does not un-pause a hidden retained view", () => {
    ctrl.installSignals();
    registerViewPolicy("calendar", { keepAlive: true, pausable: true });
    ctrl.setActive("calendar");
    ctrl.setActive("settings");
    expect(ctrl.getPhase("calendar")).toBe("paused");

    setDocumentVisibility("hidden");
    setDocumentVisibility("visible");

    expect(ctrl.getPhase("settings")).toBe("active");
    expect(ctrl.getPhase("calendar")).toBe("paused");
  });

  it("a bare visibility refocus (no prior hide) leaves hidden retained views paused", () => {
    ctrl.installSignals();
    registerViewPolicy("calendar", { keepAlive: true, pausable: true });
    ctrl.setActive("calendar");
    ctrl.setActive("settings");
    expect(ctrl.getPhase("calendar")).toBe("paused");

    // Focus events fire on plain refocus without a hidden transition too.
    setDocumentVisibility("visible");

    expect(ctrl.getPhase("calendar")).toBe("paused");
    // The active view was never paused, and stays active.
    expect(ctrl.getPhase("settings")).toBe("active");
  });
});
