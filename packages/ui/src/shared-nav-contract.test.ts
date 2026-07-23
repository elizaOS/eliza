/**
 * Cross-package contract pin for the shared-tier navigation vocabulary
 * (#17020/#17032): every view id the Tier-0 shared runtime may emit in a VIEWS
 * handoff must resolve on this client — either as a builtin shell view at its
 * canonical path, or as a plugin-declared page a dedicated runtime registers.
 * A new SHARED_NAV_TARGETS entry without a client resolution fails here before
 * it can ship a confident "Opening X for you." reply into the designed
 * not-found state (PR #17021 made the client resolve emitted ids against its
 * routable registry). Runs against the real builtin registry, no mocks.
 */

import { SHARED_NAV_TARGETS } from "@elizaos/shared/views/shared-nav-targets";
import { describe, expect, it } from "vitest";
import { withBuiltinShellViews } from "./hooks/useAvailableViews";

// Canonical client path for every builtin id the shared tier emits, asserted
// against the live TAB_PATHS-derived registry so neither side can drift alone.
const BUILTIN_NAV_PATHS: Record<string, string> = {
  settings: "/settings",
  chat: "/chat",
  camera: "/camera",
  character: "/character",
  automations: "/automations",
  background: "/background",
  documents: "/character/documents",
  memories: "/apps/memories",
  transcripts: "/apps/transcripts",
  relationships: "/apps/relationships",
  inventory: "/wallet",
};

// Views declared by dedicated-runtime plugins (unavailable to a pure Tier-0
// client, but resolvable wherever the owning plugin is loaded). Each row names
// the declaring plugin file and its canonical registered path.
const PLUGIN_VIEW_TARGETS: Record<string, string> = {
  calendar: "/calendar", // plugins/plugin-calendar/src/plugin.ts
  inbox: "/inbox", // plugins/plugin-inbox/src/plugin.ts
  finances: "/finances", // plugins/plugin-finances/src/plugin.ts
  focus: "/focus", // plugins/plugin-blocker/src/plugin.ts
  goals: "/goals", // plugins/plugin-goals/src/plugin.ts
  health: "/health", // plugins/plugin-health/src/index.ts
  todos: "/todos", // plugins/plugin-todos/src/index.ts
  notes: "/notes", // plugins/plugin-simple-views/src/plugin.ts + register.ts
  "task-coordinator": "/task-coordinator", // plugins/plugin-task-coordinator/src/index.ts
};

describe("shared-tier nav vocabulary contract", () => {
  const builtinById = new Map(
    withBuiltinShellViews([]).map((view) => [view.id, view]),
  );

  it("every emitted view id resolves on the client", () => {
    for (const [matcherId, target] of Object.entries(SHARED_NAV_TARGETS)) {
      const builtin = builtinById.get(target.viewId);
      const pluginPath = PLUGIN_VIEW_TARGETS[target.viewId];
      expect(
        builtin !== undefined || pluginPath !== undefined,
        `SHARED_NAV_TARGETS["${matcherId}"] emits viewId "${target.viewId}", ` +
          "which is neither a builtin shell view nor a known plugin view — " +
          "the client would render its not-found state",
      ).toBe(true);
      if (builtin) {
        expect(
          builtin.path,
          `builtin viewId "${target.viewId}" is registered at "${builtin.path}", ` +
            `expected "${BUILTIN_NAV_PATHS[target.viewId]}"`,
        ).toBe(BUILTIN_NAV_PATHS[target.viewId]);
      }
    }
  });

  it("the builtin expectation map matches the live registry", () => {
    for (const [viewId, path] of Object.entries(BUILTIN_NAV_PATHS)) {
      const builtin = builtinById.get(viewId);
      expect(
        builtin,
        `BUILTIN_NAV_PATHS lists "${viewId}" but withBuiltinShellViews([]) does not register it`,
      ).toBeDefined();
      expect(builtin?.path, `builtin "${viewId}" path drifted`).toBe(path);
    }
  });

  it('never emits the unroutable ids "wallet" or "help"', () => {
    for (const [matcherId, target] of Object.entries(SHARED_NAV_TARGETS)) {
      expect(
        target.viewId,
        `SHARED_NAV_TARGETS["${matcherId}"] emits "wallet", which no client registry resolves (builtin tab id is "inventory")`,
      ).not.toBe("wallet");
      expect(
        target.viewId,
        `SHARED_NAV_TARGETS["${matcherId}"] emits "help", but no Help surface exists`,
      ).not.toBe("help");
    }
    expect(
      Object.keys(SHARED_NAV_TARGETS),
      'a "help" matcher entry must not exist — the utterance falls through to the LLM turn',
    ).not.toContain("help");
  });
});
