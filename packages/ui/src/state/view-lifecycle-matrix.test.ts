// @vitest-environment jsdom
//
// View MATRIX coverage (#10202 — "current system/developer/plugin views are
// covered by the new matrix or explicitly classified with a reason").
//
// Enumerates EVERY builtin tab (the shipped system + developer views) plus a
// representative set of plugin/remote view ids, classifies each, and asserts the
// ViewLifecycleController can register → activate → hide → (evict|retain) it
// without throwing and resolves a valid retention policy. This is the executable
// inventory the issue asks for: a new builtin tab that is not classified here
// fails the suite.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TAB_PATHS } from "../navigation";
import {
  __resetViewLifecycleForTests,
  viewLifecycleController as ctrl,
  PINNED_VIEW_IDS,
  registerViewPolicy,
  resolveViewLifecyclePolicy,
} from "./view-lifecycle";

const BUILTIN_VIEW_IDS = Object.keys(TAB_PATHS).sort();

/**
 * Classification of every builtin view into the buckets the issue names. A view
 * absent here (a newly added builtin tab) fails `classifies every builtin view`.
 */
const VIEW_CLASSIFICATION: Record<string, "system" | "developer"> = {
  // System / user-facing surfaces.
  chat: "system",
  phone: "system",
  messages: "system",
  contacts: "system",
  camera: "system",
  tasks: "system",
  automations: "system",
  browser: "system",
  stream: "system",
  apps: "system",
  views: "system",
  character: "system",
  "character-select": "system",
  "character-skills": "system",
  experience: "system",
  inventory: "system",
  documents: "system",
  files: "system",
  triggers: "system",
  rolodex: "system",
  desktop: "system",
  settings: "system",
  background: "system",
  // Developer / advanced surfaces.
  plugins: "developer",
  skills: "developer",
  advanced: "developer",
  "fine-tuning": "developer",
  trajectories: "developer",
  transcripts: "developer",
  relationships: "developer",
  memories: "developer",
  runtime: "developer",
  database: "developer",
  logs: "developer",
};

// Representative plugin/remote view ids (the kind DynamicViewLoader hosts).
const PLUGIN_VIEW_IDS = ["wallet", "calendar", "shopify", "shared-canvas"];

beforeEach(() => __resetViewLifecycleForTests());
afterEach(() => __resetViewLifecycleForTests());

describe("view matrix classification", () => {
  it("classifies every shipped builtin view (system or developer)", () => {
    const unclassified = BUILTIN_VIEW_IDS.filter(
      (id) => !(id in VIEW_CLASSIFICATION),
    );
    expect(unclassified).toEqual([]);
  });

  it("covers exactly the builtin tab set with no stale entries", () => {
    const classified = Object.keys(VIEW_CLASSIFICATION).sort();
    expect(classified).toEqual(BUILTIN_VIEW_IDS);
  });

  it("pins only chat + background", () => {
    expect([...PINNED_VIEW_IDS].sort()).toEqual(["background", "chat"]);
  });
});

describe("every builtin view resolves a valid lifecycle policy", () => {
  for (const viewId of BUILTIN_VIEW_IDS) {
    it(`resolves a policy for "${viewId}"`, () => {
      const policy = resolveViewLifecyclePolicy(viewId);
      expect(typeof policy.keepAlive).toBe("boolean");
      expect(typeof policy.pausable).toBe("boolean");
      expect(typeof policy.pinned).toBe("boolean");
      // Pinned views are also keep-alive (retained), by construction.
      if (policy.pinned) expect(policy.keepAlive).toBe(true);
    });
  }
});

describe("the controller can drive every view through its lifecycle", () => {
  for (const viewId of [...BUILTIN_VIEW_IDS, ...PLUGIN_VIEW_IDS]) {
    it(`register → activate → hide for "${viewId}"`, () => {
      expect(() => {
        ctrl.register(viewId);
        ctrl.setActive(viewId);
        expect(ctrl.getPhase(viewId)).toBe("active");
        // Switch away to a scratch view; the view is hidden (evicted if default,
        // inactive/paused if pinned/keepAlive) without throwing.
        ctrl.setActive("__scratch__");
        const phase = ctrl.getPhase(viewId);
        const pinned = PINNED_VIEW_IDS.has(viewId);
        if (pinned) {
          expect(phase).not.toBeNull();
        } else {
          // default views evict (null); keepAlive views go paused/inactive.
          expect(
            phase === null || phase === "paused" || phase === "inactive",
          ).toBe(true);
        }
      }).not.toThrow();
    });
  }
});

describe("plugin views can opt into keep-alive via registerViewPolicy", () => {
  it("honors a runtime keepAlive override for a plugin view", () => {
    registerViewPolicy("calendar", { keepAlive: true });
    ctrl.setActive("calendar");
    ctrl.setActive("settings");
    // calendar retained (keepAlive), settings active.
    expect(ctrl.getRetainedKeepAliveIds()).toContain("calendar");
  });
});
