// @vitest-environment jsdom
//
// ViewLifecycleController state-machine + bounded-LRU + exemptions + signal-bus
// unit tests (issue #10202). Pure controller exercise — no React rendering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import {
  __resetViewLifecycleForTests,
  viewLifecycleController as ctrl,
  PINNED_VIEW_IDS,
  registerViewPolicy,
  resolveViewLifecyclePolicy,
} from "./view-lifecycle";

let clock = 1_000;

beforeEach(() => {
  __resetViewLifecycleForTests();
  clock = 1_000;
  ctrl.now = () => clock;
});

afterEach(() => {
  __resetViewLifecycleForTests();
});

function tick(ms: number) {
  clock += ms;
}

describe("resolveViewLifecyclePolicy", () => {
  it("defaults to unmount-on-hide + pausable + not pinned", () => {
    expect(resolveViewLifecyclePolicy("settings")).toEqual({
      keepAlive: false,
      pausable: true,
      pinned: false,
    });
  });

  it("pins chat and background and forces keepAlive on them", () => {
    for (const id of PINNED_VIEW_IDS) {
      const policy = resolveViewLifecyclePolicy(id);
      expect(policy.pinned).toBe(true);
      expect(policy.keepAlive).toBe(true);
    }
  });

  it("merges runtime overrides over the default", () => {
    registerViewPolicy("calendar", { keepAlive: true });
    expect(resolveViewLifecyclePolicy("calendar")).toMatchObject({
      keepAlive: true,
      pausable: true,
      pinned: false,
    });
  });
});

describe("ViewLifecycleController.setActive", () => {
  it("activates a view (phase active) and publishes the render set", () => {
    const changes = vi.fn();
    ctrl.subscribe(changes);
    ctrl.setActive("settings");
    expect(ctrl.getPhase("settings")).toBe("active");
    expect(ctrl.getRenderSet().activeId).toBe("settings");
    expect(ctrl.getRenderSet().retainedIds).toContain("settings");
    expect(changes).toHaveBeenCalled();
  });

  it("unmounts (evicts) a default view when another becomes active", () => {
    ctrl.setActive("settings");
    ctrl.setActive("runtime");
    // settings is non-keepAlive → evicted on hide, gone from the registry.
    expect(ctrl.getPhase("settings")).toBeNull();
    expect(ctrl.getRenderSet().retainedIds).toEqual(["runtime"]);
  });

  it("retains + pauses a keep-alive view when hidden", () => {
    registerViewPolicy("calendar", { keepAlive: true, pausable: true });
    ctrl.setActive("calendar");
    ctrl.setActive("settings");
    // calendar is keepAlive → retained but paused, not evicted.
    expect(ctrl.getPhase("calendar")).toBe("paused");
    expect(ctrl.getRenderSet().retainedIds).toEqual(
      expect.arrayContaining(["calendar", "settings"]),
    );
  });

  it("fires per-view transitions to subscribers", () => {
    registerViewPolicy("calendar", { keepAlive: true });
    const seen: string[] = [];
    ctrl.subscribeView("calendar", (t) => seen.push(t.phase));
    ctrl.setActive("calendar");
    ctrl.setActive("settings");
    expect(seen).toEqual(expect.arrayContaining(["active", "paused"]));
  });
});

describe("bounded LRU eviction", () => {
  it("evicts the least-recently-active retained view beyond the cap", () => {
    // Force a small, deterministic cap.
    const ids = ["v1", "v2", "v3", "v4", "v5"];
    for (const id of ids) registerViewPolicy(id, { keepAlive: true });
    for (const id of ids) {
      tick(10);
      ctrl.setActive(id);
    }
    // Cap bounds the EVICTABLE (hidden, non-exempt) views to 3 (CI reports no
    // deviceMemory → 3). So total non-pinned keep-alive = active (v5) + ≤3
    // hidden = ≤4; the oldest hidden (v1) is evicted.
    const retained = ctrl.getRetainedKeepAliveIds();
    const hidden = retained.filter((id) => id !== ctrl.getActiveId());
    expect(hidden.length).toBeLessThanOrEqual(3);
    expect(retained.length).toBeLessThanOrEqual(4);
    expect(retained).not.toContain("v1");
    expect(retained).toContain("v5"); // active, never evicted
  });

  it("never evicts a pinned view even under pressure", () => {
    ctrl.setActive("chat"); // pinned
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      registerViewPolicy(id, { keepAlive: true });
      ctrl.setActive(id);
    }
    // chat stays registered + pinned despite the churn.
    expect(ctrl.getPhase("chat")).not.toBeNull();
    expect(PINNED_VIEW_IDS.has("chat")).toBe(true);
  });
});

describe("crash + recovery", () => {
  it("marks crashed, then recovers the active view back to active", () => {
    ctrl.setActive("settings");
    ctrl.markCrashed("settings");
    expect(ctrl.getPhase("settings")).toBe("crashed");
    // markRecovering passes through "recovering" then resolves to the resting
    // phase — the active view returns to "active" (not stuck in recovering).
    ctrl.markRecovering("settings");
    expect(ctrl.getPhase("settings")).toBe("active");
  });

  it("emits the transient recovering transition to subscribers", () => {
    ctrl.setActive("settings");
    ctrl.markCrashed("settings");
    const seen: string[] = [];
    ctrl.subscribeView("settings", (t) => seen.push(t.phase));
    ctrl.markRecovering("settings");
    expect(seen).toEqual(["recovering", "active"]);
  });
});

describe("signal bus", () => {
  it("pauses pausable views on APP_PAUSE and resumes on APP_RESUME", () => {
    ctrl.installSignals();
    registerViewPolicy("calendar", { keepAlive: true, pausable: true });
    ctrl.setActive("calendar");
    expect(ctrl.getPhase("calendar")).toBe("active");

    window.dispatchEvent(new Event(APP_PAUSE_EVENT));
    expect(ctrl.getPhase("calendar")).toBe("paused");

    window.dispatchEvent(new Event(APP_RESUME_EVENT));
    expect(ctrl.getPhase("calendar")).toBe("active");
  });

  it("force-evicts retained non-pinned views on memorypressure", () => {
    ctrl.installSignals();
    registerViewPolicy("calendar", { keepAlive: true });
    ctrl.setActive("calendar");
    ctrl.setActive("chat"); // calendar now retained+hidden, chat active(pinned)
    expect(ctrl.getRetainedKeepAliveIds()).toContain("calendar");

    window.dispatchEvent(new Event("memorypressure"));
    expect(ctrl.getPhase("calendar")).toBeNull(); // evicted
    expect(ctrl.getPhase("chat")).not.toBeNull(); // pinned survives
  });

  it("evicts a retained view after its TTL with fake timers", () => {
    vi.useFakeTimers();
    try {
      registerViewPolicy("calendar", { keepAlive: true });
      ctrl.setActive("calendar");
      ctrl.setActive("settings"); // calendar retained, TTL scheduled
      expect(ctrl.getRetainedKeepAliveIds()).toContain("calendar");
      vi.advanceTimersByTime(10 * 60_000); // > max TTL (5 min)
      expect(ctrl.getPhase("calendar")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("eviction telemetry", () => {
  it("emits a view-lifecycle module-cache event on evict", () => {
    const events: unknown[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener("eliza:module-cache-telemetry", handler);
    (
      globalThis as { __ELIZA_MODULE_CACHE_TELEMETRY__?: unknown[] }
    ).__ELIZA_MODULE_CACHE_TELEMETRY__ = [];
    ctrl.setActive("settings");
    ctrl.setActive("runtime"); // settings default → evict
    window.removeEventListener("eliza:module-cache-telemetry", handler);
    const viewLifecycleEvents = events.filter(
      (e) => (e as { source?: string }).source === "view-lifecycle",
    );
    expect(viewLifecycleEvents.length).toBeGreaterThanOrEqual(1);
    expect(viewLifecycleEvents[0]).toMatchObject({ action: "evict" });
  });
});
