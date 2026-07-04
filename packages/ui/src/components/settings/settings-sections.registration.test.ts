// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTINGS_SECTION_META } from "./settings-section-meta";
import { getAllSettingsSections } from "./settings-section-registry";
// Static import: evaluating the heavy module runs its top-level registration
// side effects, exactly as the lazy `SettingsView` does when it mounts.
import {
  assertMetaCatalogParity,
  SETTINGS_SECTIONS,
} from "./settings-sections";

/**
 * Guards the #10724 lazy-load seam: the eager boot barrels (`index.ts` /
 * `browser.ts`) re-export the registry accessors from the light
 * `settings-section-registry` module, so `settings-sections.ts` (the heavy
 * component graph) no longer loads at boot — it loads when the lazy
 * `SettingsView` imports it. This test proves that importing the heavy module
 * still runs its registration side effects, so every built-in section is
 * present once the Settings view mounts.
 */
describe("settings-sections registration (lazy boot seam)", () => {
  const registeredIds = new Set(
    getAllSettingsSections().map((section) => section.id),
  );

  it("registers every canonical built-in section on import", () => {
    for (const meta of SETTINGS_SECTION_META) {
      expect(
        registeredIds.has(meta.id),
        `built-in section "${meta.id}" was not registered`,
      ).toBe(true);
    }
  });

  it("also registers the folded-in cloud + runtime sections", () => {
    // These used to be ad-hoc `registerSettingsSection(...)` bypass calls; they
    // are now single-source entries in BUILTIN_SECTION_DEFINITIONS carrying
    // `catalog: false`, registered by the same data-driven loop.
    for (const id of ["cloud-overview", "cloud-agents", "my-runtimes"]) {
      expect(registeredIds.has(id), `section "${id}" missing`).toBe(true);
    }
  });
});

/**
 * The audit fix (#12089 item 31 / #12677) folds the parallel `SECTION_VISUALS`
 * map and the three ad-hoc `registerSettingsSection(...)` bypass calls into one
 * canonical per-id definition list, with an explicit two-way parity guard
 * against the pinned pure-data META. These tests pin that the merge holds and
 * the old central couplings do not creep back.
 */
describe("settings-sections canonical definitions (no META/VISUALS drift)", () => {
  it("passes the module-load META parity guard", () => {
    // Already runs at import time; calling again proves it is a pure, callable
    // check and did not throw for the current definitions.
    expect(() => assertMetaCatalogParity()).not.toThrow();
  });

  it("exposes the catalog sections in exact META id + label + order", () => {
    expect(
      SETTINGS_SECTIONS.map((s) => ({ id: s.id, label: s.defaultLabel })),
    ).toEqual(
      SETTINGS_SECTION_META.map((m) => ({ id: m.id, label: m.defaultLabel })),
    );
  });

  it("carries each catalog section's declared META aliases onto the registered def", () => {
    const byId = new Map(
      getAllSettingsSections().map((s) => [s.id, s] as const),
    );
    for (const meta of SETTINGS_SECTION_META) {
      const registered = byId.get(meta.id);
      expect(registered, `section "${meta.id}" not registered`).toBeDefined();
      expect([...(registered?.aliases ?? [])]).toEqual([
        ...(meta.aliases ?? []),
      ]);
    }
  });

  it("registers the non-catalog sections OUTSIDE the pinned META catalog", () => {
    const metaIds = new Set(SETTINGS_SECTION_META.map((m) => m.id));
    for (const id of ["cloud-overview", "cloud-agents", "my-runtimes"]) {
      expect(metaIds.has(id), `"${id}" leaked into the pinned catalog`).toBe(
        false,
      );
    }
    // ...but they still resolve from the live registry (Settings renders them).
    const registeredIds = new Set(getAllSettingsSections().map((s) => s.id));
    for (const id of ["cloud-overview", "cloud-agents", "my-runtimes"]) {
      expect(registeredIds.has(id)).toBe(true);
    }
  });

  it("preserves the folded-in sections' group + order (behavior-preserving fold)", () => {
    const byId = new Map(
      getAllSettingsSections().map((s) => [s.id, s] as const),
    );
    expect(byId.get("cloud-overview")?.order).toBe(1.45);
    expect(byId.get("cloud-agents")?.order).toBe(1.55);
    expect(byId.get("my-runtimes")?.order).toBe(3.5);
    expect(byId.get("my-runtimes")?.group).toBe("system");
  });

  it("grep-guard: the parallel SECTION_VISUALS map and ad-hoc bypass calls are gone from executable paths", () => {
    // Read the module source cwd-independently: vitest's transformed
    // `import.meta.url` is not a usable file: URL here, so resolve the file by
    // trying the package-root-relative path (cwd = packages/ui) and the
    // repo-root-relative path (cwd = repo root, e.g. a direct root invocation).
    const rel = "src/components/settings/settings-sections.ts";
    const candidates = [
      join(process.cwd(), rel),
      join(process.cwd(), "packages/ui", rel),
    ];
    const modulePath = candidates.find((p) => existsSync(p));
    expect(
      modulePath,
      `could not locate settings-sections.ts from cwd ${process.cwd()}`,
    ).toBeDefined();
    const source = readFileSync(modulePath as string, "utf8");
    // Strip line + block comments so historical mentions in doc comments don't
    // trip the guard — only executable code is checked.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/SECTION_VISUALS/);
    // Exactly one registerSettingsSection call site survives: the data-driven
    // loop. The three inline object-literal bypass calls must be gone.
    const registerCalls = code.match(/\bregisterSettingsSection\s*\(/g) ?? [];
    expect(registerCalls.length).toBe(1);
    // The old runtime hand-sync error string must not survive.
    expect(code).not.toMatch(/Missing settings-section visuals/);
  });
});
