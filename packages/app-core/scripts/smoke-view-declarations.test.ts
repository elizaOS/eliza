/**
 * Parity + provenance contract for the UI-smoke plugin-view stub. Runs against
 * the real repo tree (no mocks): asserts every declared smoke view still maps to
 * a shipping plugin, that a removed plugin id is caught, and that a
 * production-declared view can never be served as a fabricated bundle in audit
 * mode. Guards issue #15791.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkSmokeViewParity,
  resolveBundleProvenance,
  smokeViewDeclarations,
} from "./smoke-view-declarations.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const REMOVED_PLUGIN_IDS = ["removed-plugin-fixture"];

describe("smoke view declaration parity (#15791)", () => {
  it("every shipped declaration maps to a plugin that still registers it", () => {
    const { ok, missing } = checkSmokeViewParity(repoRoot);
    expect(
      missing,
      `smoke views out of parity with production: ${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
    expect(ok).toBe(true);
  });

  it("does not declare any removed plugin view", () => {
    const declaredIds = smokeViewDeclarations.map(([id]) => id);
    for (const removed of REMOVED_PLUGIN_IDS) {
      expect(
        declaredIds,
        `${removed} was removed from production and must not be declared in the smoke stub`,
      ).not.toContain(removed);
    }
  });

  it("declares the canonical Cloud, Notes, and Calendar views used by the visual audit", () => {
    expect(smokeViewDeclarations).toEqual(
      expect.arrayContaining([
        [
          "cloud",
          "Cloud",
          "plugin-elizacloud",
          "/cloud",
          "CloudView",
          "gui",
          { capabilities: ["agent-surface"] },
        ],
        ["notes", "Notes", "plugin-notes", "/notes", "NotesView"],
        [
          "calendar",
          "Calendar",
          "plugin-calendar",
          "/calendar",
          "CalendarView",
        ],
      ]),
    );
    expect(smokeViewDeclarations.map(([id]) => id)).not.toContain(
      "simple-calendar",
    );
  });

  it("fails parity when a deleted plugin id is (re)introduced", () => {
    const withRemoved = [
      ...smokeViewDeclarations,
      [
        "removed-plugin-fixture",
        "Removed Plugin",
        "plugin-removed-fixture",
        "/removed-plugin",
        "RemovedPluginView",
      ],
    ];
    const { ok, missing } = checkSmokeViewParity(repoRoot, withRemoved);
    expect(ok).toBe(false);
    expect(missing.map((entry) => entry.id)).toContain(
      "removed-plugin-fixture",
    );
    expect(
      missing.find((entry) => entry.id === "removed-plugin-fixture")?.reason,
    ).toBe("plugin-directory-missing");
  });

  it("fails parity when a live plugin no longer exports the declared component", () => {
    // notes exists, but a bogus export name must be rejected — this is the
    // "a route cannot pass against the wrong component" guard.
    const wrongComponent = [
      ["notes", "Notes", "plugin-notes", "/notes", "NotARealNotesExport"],
    ];
    const { ok, missing } = checkSmokeViewParity(repoRoot, wrongComponent);
    expect(ok).toBe(false);
    expect(missing[0]?.reason).toBe("component-export-missing");
  });
});

describe("view bundle provenance (#15791)", () => {
  it("serves the real built bundle when present", () => {
    const provenance = resolveBundleProvenance({
      viewId: "notes",
      realBundleExists: true,
      requireRealBundle: false,
    });
    expect(provenance).toEqual({
      mode: "real-dist",
      status: 200,
      synthesized: false,
    });
  });

  it("audit mode fails observably instead of fabricating a bundle", () => {
    const provenance = resolveBundleProvenance({
      viewId: "notes",
      realBundleExists: false,
      requireRealBundle: true,
    });
    expect(provenance.mode).toBe("missing-real-bundle");
    expect(provenance.status).toBe(424);
    expect(provenance.synthesized).toBe(false);
  });

  it("non-audit mode marks a synthesized placeholder as synthesized", () => {
    const generic = resolveBundleProvenance({
      viewId: "polymarket",
      realBundleExists: false,
      requireRealBundle: false,
    });
    expect(generic.mode).toBe("synthesized-generic");
    expect(generic.synthesized).toBe(true);
    expect(generic.status).toBe(200);

    const dedicated = resolveBundleProvenance({
      viewId: "screenshare",
      realBundleExists: false,
      requireRealBundle: false,
    });
    expect(dedicated.mode).toBe("synthesized-screenshare");
  });
});
