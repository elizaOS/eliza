/**
 * Unit + drift-guard coverage for the builtin static-tab registry that owns
 * (a) the router's canonical-id / alias resolution and (b) the builtin-level
 * screen background policy — the two enumerations that used to live as parallel
 * name-keyed if-chains in App.tsx (audit item #34, #12680).
 *
 * These tests pin the exact legacy behavior of `builtinRouteBackgroundPolicy`
 * and the router's alias handling, and a grep-guard proves the old central
 * if-chains are gone from App.tsx's executable paths.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TAB_METADATA,
  resolveBuiltinBackgroundPolicy,
  resolveBuiltinTabId,
} from "./builtin-tab-registry";

describe("builtin-tab-registry: table integrity", () => {
  it("has unique canonical ids and no id/alias collisions", () => {
    const seen = new Set<string>();
    for (const entry of BUILTIN_TAB_METADATA) {
      expect(seen.has(entry.id), `duplicate id ${entry.id}`).toBe(false);
      seen.add(entry.id);
      for (const alias of entry.aliases ?? []) {
        expect(
          seen.has(alias),
          `alias ${alias} collides with an existing id/alias`,
        ).toBe(false);
        seen.add(alias);
      }
    }
  });

  it("every alias resolves to its canonical owner id", () => {
    for (const entry of BUILTIN_TAB_METADATA) {
      for (const alias of entry.aliases ?? []) {
        expect(resolveBuiltinTabId(alias)).toBe(entry.id);
      }
    }
  });
});

describe("resolveBuiltinTabId: alias resolution", () => {
  it("maps the known legacy aliases onto canonical ids", () => {
    expect(resolveBuiltinTabId("triggers")).toBe("automations");
    expect(resolveBuiltinTabId("advanced")).toBe("fine-tuning");
  });

  it("returns canonical ids unchanged", () => {
    expect(resolveBuiltinTabId("automations")).toBe("automations");
    expect(resolveBuiltinTabId("fine-tuning")).toBe("fine-tuning");
    expect(resolveBuiltinTabId("settings")).toBe("settings");
  });

  it("passes non-builtin / plugin tab ids straight through", () => {
    expect(resolveBuiltinTabId("some-plugin-tab")).toBe("some-plugin-tab");
    expect(resolveBuiltinTabId("")).toBe("");
  });
});

describe("resolveBuiltinBackgroundPolicy: legacy parity", () => {
  // Golden table covering the builtinRouteBackgroundPolicy table:
  //   chat / background       -> "shared"
  //   views  && path==/views  -> "shared"
  //   apps   && path==/apps   -> "shared"
  //   otherwise               -> null (fall through to downstream resolution)
  it.each([
    ["chat", "/chat", "shared"],
    ["chat", "/anything", "shared"],
    ["background", "/background", "shared"],
  ] as const)("%s @ %s -> %s (unconditional shared)", (tab, path, expected) => {
    expect(resolveBuiltinBackgroundPolicy(tab, path)).toBe(expected);
  });

  it("views is shared only at /views, else null", () => {
    expect(resolveBuiltinBackgroundPolicy("views", "/views")).toBe("shared");
    expect(resolveBuiltinBackgroundPolicy("views", "/views/thing")).toBeNull();
  });

  it("apps is shared only at /apps, else null", () => {
    expect(resolveBuiltinBackgroundPolicy("apps", "/apps")).toBe("shared");
    expect(resolveBuiltinBackgroundPolicy("apps", "/apps/tasks")).toBeNull();
  });

  it.each([
    ["voice", "/voice"],
    ["settings", "/settings"],
    ["files", "/apps/files"],
    ["memories", "/apps/memories"],
    ["some-plugin-tab", "/plugin"],
    ["triggers", "/automations"],
  ] as const)("%s @ %s -> null (no builtin policy)", (tab, path) => {
    expect(resolveBuiltinBackgroundPolicy(tab, path)).toBeNull();
  });
});

describe("App.tsx drift guard: legacy central enumerations removed", () => {
  const appSource = readFileSync(
    fileURLToPath(new URL("./App.tsx", import.meta.url)),
    "utf8",
  );

  it("builtinRouteBackgroundPolicy no longer inlines the per-tab if-chain", () => {
    // The background resolver must delegate to the registry, not re-derive
    // policy from `tab === "..."` string branches.
    const fnStart = appSource.indexOf("function builtinRouteBackgroundPolicy(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = appSource.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain("resolveBuiltinBackgroundPolicy");
    expect(fnBody).not.toContain('tab === "chat"');
    expect(fnBody).not.toContain('tab === "settings"');
    expect(fnBody).not.toContain('tab === "views"');
    expect(fnBody).not.toContain('tab === "apps"');
  });

  it("renderStaticViewRouterTab routes via a keyed registry, not the alias if-chain", () => {
    const fnStart = appSource.indexOf("function renderStaticViewRouterTab(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = appSource.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain("resolveBuiltinTabId");
    expect(fnBody).toContain("buildStaticTabRenderers()");
    // The alias / special-surface if-chain that lived at the tail of the old
    // renderStaticViewRouterTab is gone from its body.
    expect(fnBody).not.toContain('tab === "fine-tuning" || tab === "advanced"');
    expect(fnBody).not.toContain(
      'tab === "character" || tab === "character-select"',
    );
    expect(fnBody).not.toContain('tab === "views" || tab === "apps"');
  });
});
