/**
 * Cross-package contract pin for the shared-tier navigation vocabulary
 * (#17020/#17032): every view id the Tier-0 shared runtime may emit in a VIEWS
 * handoff must resolve on this client — either as a builtin shell view at its
 * canonical path, or as a plugin-declared page a dedicated runtime registers.
 * A new SHARED_NAV_TARGETS entry without a client resolution fails here before
 * it can ship a confident "Opening X for you." reply into nowhere: the client
 * resolves emitted ids against its routable registry (PR #17021), but an id
 * that registry cannot resolve still falls back to a blind /apps/<id>
 * navigation — the designed not-found render for unclaimed /apps/<slug> routes
 * is #17033. Builtin ids run against the real registry, no mocks; plugin ids
 * are pinned to their declaring plugin source files read from the monorepo, so
 * a plugin renaming its view id or path breaks this test instead of silently
 * reintroducing the drift.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCUMENTS_NAV_VOCABULARY,
  SHARED_NAV_TARGETS,
  SHARED_NAV_UI_LOCALES,
} from "@elizaos/shared/views/shared-nav-targets";
import { describe, expect, it } from "vitest";
import { withBuiltinShellViews } from "./hooks/useAvailableViews";

// Canonical client path for every builtin id the shared tier emits, asserted
// against the live TAB_PATHS-derived registry so neither side can drift alone.
const BUILTIN_NAV_PATHS: Record<string, string> = {
  settings: "/settings",
  vault: "/vault",
  chat: "/chat",
  character: "/character",
  automations: "/automations",
  background: "/background",
  documents: "/character/documents",
  memories: "/apps/memories",
  transcripts: "/apps/transcripts",
  relationships: "/apps/relationships",
  inventory: "/wallet",
};

/** A shared-tier view id owned by a plugin, pinned to its declaring source. */
interface PluginViewPin {
  /** Canonical path the plugin registers the view at. */
  path: string;
  /** Repo-relative source files that must declare BOTH the id and the path. */
  sources: string[];
}

interface HostViewPin {
  path: string;
  source: string;
}

// Views declared by dedicated-runtime plugins (unavailable to a pure Tier-0
// client, but resolvable wherever the owning plugin is loaded). The literal
// map is the expectation; the fs read below is the pin — each declaring source
// file is read from the monorepo and must still contain the exact id + path,
// so a plugin rename fails here instead of shipping undetected drift.
const PLUGIN_VIEW_TARGETS: Record<string, PluginViewPin> = {
  calendar: {
    path: "/calendar",
    sources: ["plugins/plugin-calendar/src/plugin.ts"],
  },
  inbox: { path: "/inbox", sources: ["plugins/plugin-inbox/src/plugin.ts"] },
  finances: {
    path: "/finances",
    sources: ["plugins/plugin-finances/src/plugin.ts"],
  },
  focus: { path: "/focus", sources: ["plugins/plugin-blocker/src/plugin.ts"] },
  goals: { path: "/goals", sources: ["plugins/plugin-goals/src/plugin.ts"] },
  health: { path: "/health", sources: ["plugins/plugin-health/src/index.ts"] },
  todos: { path: "/todos", sources: ["plugins/plugin-todos/src/index.ts"] },
  notes: {
    path: "/notes",
    sources: [
      "plugins/plugin-notes/src/plugin.ts",
      "plugins/plugin-notes/src/register.ts",
    ],
  },
  "task-coordinator": {
    path: "/task-coordinator",
    sources: ["plugins/plugin-task-coordinator/src/index.ts"],
  },
};

// Host-owned pages are bundled by packages/app rather than declared by a
// plugin. The native shell registers this path in-process; the web shell turns
// the same path into a compatibility redirect to its authenticated cloud route.
const HOST_VIEW_TARGETS: Record<string, HostViewPin> = {
  "cloud-apps": {
    path: "/cloud-apps",
    source: "packages/app/src/cloud-apps-view.ts",
  },
};

// This test only runs in-repo, so the monorepo root is a fixed hop above this
// file (packages/ui/src → repo root) and a missing source file is a hard fail,
// never a skip.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("shared-tier nav vocabulary contract", () => {
  const builtinById = new Map(
    withBuiltinShellViews([]).map((view) => [view.id, view]),
  );

  it("every emitted view id resolves on the client", () => {
    for (const [matcherId, target] of Object.entries(SHARED_NAV_TARGETS)) {
      const builtin = builtinById.get(target.viewId);
      const pluginPin = PLUGIN_VIEW_TARGETS[target.viewId];
      const hostPin = HOST_VIEW_TARGETS[target.viewId];
      expect(
        builtin !== undefined ||
          pluginPin !== undefined ||
          hostPin !== undefined,
        `SHARED_NAV_TARGETS["${matcherId}"] emits viewId "${target.viewId}", ` +
          "which is neither a builtin shell view nor a known plugin/host view — " +
          "the client would blind-navigate to /apps/<id> (not-found render: #17033)",
      ).toBe(true);
      if (builtin) {
        expect(
          builtin.path,
          `builtin viewId "${target.viewId}" is registered at "${builtin.path}", ` +
            `expected "${BUILTIN_NAV_PATHS[target.viewId]}"`,
        ).toBe(BUILTIN_NAV_PATHS[target.viewId]);
      }
      if (hostPin) {
        expect(
          target.viewPath,
          `host-owned target "${target.viewId}" must carry its canonical path`,
        ).toBe(hostPin.path);
      }
    }
  });

  it("routes the documents matcher id to the Knowledge builtin", () => {
    expect(SHARED_NAV_TARGETS.documents).toEqual({
      viewId: "documents",
      label: "Knowledge",
    });
    expect(builtinById.get("documents")).toMatchObject({
      id: "documents",
      label: "Knowledge",
      path: "/character/documents",
    });
  });

  it("keeps the semantic vocabulary aligned with every shipped UI label", () => {
    for (const locale of SHARED_NAV_UI_LOCALES) {
      const catalogPath = resolve(
        REPO_ROOT,
        `packages/ui/src/i18n/locales/${locale}.json`,
      );
      const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
      const label =
        catalog !== null &&
        typeof catalog === "object" &&
        !Array.isArray(catalog)
          ? Reflect.get(catalog, "nav.documents")
          : undefined;
      expect(
        label,
        `${locale} nav.documents drifted from the shared Knowledge routing vocabulary`,
      ).toBe(DOCUMENTS_NAV_VOCABULARY.localizedLabels[locale]);
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

  it("every plugin view pin is still declared by its plugin source", () => {
    for (const [viewId, pin] of Object.entries(PLUGIN_VIEW_TARGETS)) {
      for (const source of pin.sources) {
        const filePath = resolve(REPO_ROOT, source);
        expect(
          existsSync(filePath),
          `plugin view "${viewId}": declaring source ${source} is missing — ` +
            "point PLUGIN_VIEW_TARGETS at the plugin's new declaring file",
        ).toBe(true);
        const contents = readFileSync(filePath, "utf8");
        expect(
          new RegExp(`id:\\s*"${viewId}"`).test(contents),
          `plugin view "${viewId}": ${source} no longer declares id: "${viewId}"`,
        ).toBe(true);
        expect(
          new RegExp(`path:\\s*"${pin.path}"`).test(contents),
          `plugin view "${viewId}": ${source} no longer declares path: "${pin.path}"`,
        ).toBe(true);
      }
    }
  });

  it("every host view pin is still registered at its client path", () => {
    for (const [viewId, pin] of Object.entries(HOST_VIEW_TARGETS)) {
      const filePath = resolve(REPO_ROOT, pin.source);
      expect(
        existsSync(filePath),
        `host view "${viewId}": declaring source ${pin.source} is missing`,
      ).toBe(true);
      const contents = readFileSync(filePath, "utf8");
      expect(contents).toContain(`id: "${viewId}"`);
      expect(contents).toContain(`path: "${pin.path}"`);
    }
  });

  it('never emits "wallet" (no such client id) nor "help"/"camera" (no shared-tier surfaces)', () => {
    for (const [matcherId, target] of Object.entries(SHARED_NAV_TARGETS)) {
      expect(
        target.viewId,
        `SHARED_NAV_TARGETS["${matcherId}"] emits "wallet", which no client registry resolves (builtin tab id is "inventory")`,
      ).not.toBe("wallet");
      expect(
        target.viewId,
        `SHARED_NAV_TARGETS["${matcherId}"] emits "help", but no Help surface exists`,
      ).not.toBe("help");
      expect(
        target.viewId,
        `SHARED_NAV_TARGETS["${matcherId}"] emits "camera", an AOSP-fork-only surface no shared-tier client (web/desktop/iOS) renders`,
      ).not.toBe("camera");
    }
    expect(
      Object.keys(SHARED_NAV_TARGETS),
      'a "help" matcher entry must not exist — the utterance falls through to the LLM turn',
    ).not.toContain("help");
    expect(
      Object.keys(SHARED_NAV_TARGETS),
      'a "camera" matcher entry must not exist — AOSP devices run dedicated runtimes whose VIEWS action handles camera; shared-tier utterances fall through to the LLM turn',
    ).not.toContain("camera");
  });
});
