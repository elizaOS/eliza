/**
 * Drift guard for the default-home widget sink opt-ins (#12089 item 35).
 *
 * App-manifest plugins that do not ship an owned home card used to opt into a
 * shared default sink via a ~23-entry `PluginWidgetDeclaration` literal
 * hardcoded inline in `registry.ts` — a second, hand-maintained widget registry
 * that duplicated each plugin's `pluginId` and had to be edited in the UI trunk
 * to add/remove a plugin. That inline literal is now the co-located, explicitly-
 * marked legacy host-owned fallback table
 * (`LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS`), derived into declarations by a pure
 * builder. These tests assert:
 *   1. No inline default-home plugin-declaration literal survives in the
 *      `registry.ts` executable trunk (grep guard).
 *   2. The builder reproduces the exact prior declaration shape (behavior-
 *      preserving id/slot/order/defaultEnabled derivation).
 *   3. Structural fields are derived uniformly — a row cannot drift on shape.
 *   4. A plugin-owned/server declaration wins over its legacy fallback row, so
 *      the fallback table cannot silently diverge from a migrated plugin.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildDefaultHomeWidgetDeclarations,
  DEFAULT_HOME_WIDGET_OPTIN_ORDER_BASE,
  LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS,
} from "./default-home-widget-sink-optins";
import { registerWidgetComponent, resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration } from "./types";

const registrySource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "registry.ts"),
  "utf8",
);

describe("default-home widget sink opt-ins drift guard (#12089 item 35)", () => {
  it("removed the inline default-home plugin declaration literal from registry.ts", () => {
    // The coupling this audit item targets: a hardcoded array of plugin widget
    // declarations in the UI trunk. Its `.default-home` id template and the
    // per-row `.map(...)` assembly must no longer live in registry.ts (outside
    // of reference comments) — the opt-ins now come from the co-located table.
    const executable = registrySource
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return !(trimmed.startsWith("//") || trimmed.startsWith("*"));
      })
      .join("\n");
    // No inline `.default-home` id-template assembly.
    expect(executable).not.toContain(".default-home`");
    // No inline per-plugin literal rows (a representative sample of the moved
    // pluginIds must not reappear as string literals in the trunk).
    for (const id of ["birdclaw", "hyperliquid", "polymarket", "wifi"]) {
      expect(executable).not.toContain(`"${id}"`);
    }
    // The trunk assembles from the builder, not an inline map.
    expect(executable).toContain("buildDefaultHomeWidgetDeclarations()");
  });

  it("builds declarations with the exact prior structural shape", () => {
    const built = buildDefaultHomeWidgetDeclarations();
    expect(built).toHaveLength(LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS.length);

    built.forEach((decl, index) => {
      const optIn = LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS[index];
      // Structural fields derived uniformly (the pre-refactor `.map` output).
      expect(decl.id).toBe(`${optIn.pluginId}.default-home`);
      expect(decl.slot).toBe("home");
      expect(decl.order).toBe(DEFAULT_HOME_WIDGET_OPTIN_ORDER_BASE + index);
      expect(decl.defaultEnabled).toBe(true);
      // Owner-declared fields carried through verbatim.
      expect(decl.pluginId).toBe(optIn.pluginId);
      expect(decl.label).toBe(optIn.label);
      expect(decl.icon).toBe(optIn.icon);
      expect(decl.defaultWidget).toBe(optIn.defaultWidget);
      expect(decl.signalKinds).toEqual(optIn.signalKinds);
      // None carry an explicit visibility flag — they are snapshot-gated, so a
      // plugin must be present+active for its default-sink tile to show.
      expect(decl.visibility).toBeUndefined();
    });
  });

  it("derives structural fields uniformly regardless of input order", () => {
    // A row cannot drift on `id`/`slot`/`order`/`defaultEnabled` shape: the
    // builder assigns them from position, not from the row.
    const built = buildDefaultHomeWidgetDeclarations([
      {
        pluginId: "alpha",
        label: "Alpha",
        icon: "A",
        defaultWidget: "activity",
        signalKinds: ["activity"],
      },
      {
        pluginId: "beta",
        label: "Beta",
        icon: "B",
        defaultWidget: "notifications",
        signalKinds: ["notification"],
      },
    ]);
    expect(built.map((d) => d.id)).toEqual([
      "alpha.default-home",
      "beta.default-home",
    ]);
    expect(built.map((d) => d.order)).toEqual([
      DEFAULT_HOME_WIDGET_OPTIN_ORDER_BASE,
      DEFAULT_HOME_WIDGET_OPTIN_ORDER_BASE + 1,
    ]);
    expect(built.every((d) => d.slot === "home")).toBe(true);
    expect(built.every((d) => d.defaultEnabled === true)).toBe(true);
  });

  it("keeps every legacy opt-in row keyed by a unique pluginId", () => {
    // Membership-not-position is the contract; duplicate pluginIds would produce
    // colliding `.default-home` ids and a silently-dropped tile.
    const ids = LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS.map((o) => o.pluginId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("suppresses the legacy fallback row once its plugin ships an owned home card", () => {
    // The drift mode the audit flags: a plugin migrating to its own
    // `Plugin.widgets` must not be shadowed by — nor double up with — a stale
    // legacy fallback row. Because the resolver dedupes on `pluginId/id`, an
    // owned server widget with a DIFFERENT id would otherwise render alongside
    // the plugin's `${pluginId}.default-home` sink tile. The resolver now
    // suppresses the generic default-sink fallback for any plugin that already
    // resolves to its own home card, so exactly the owned card renders.
    const legacyRow = LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS[0];
    const pluginId = legacyRow.pluginId;

    // First: with NO owned card, the legacy default-sink fallback resolves for a
    // present+active plugin (baseline the suppression acts against).
    const fallbackOnly = resolveWidgetsForSlot("home", [
      { id: pluginId, enabled: true, isActive: true },
    ]);
    expect(
      fallbackOnly.find((r) => r.declaration.id === `${pluginId}.default-home`),
    ).toBeTruthy();

    // Now the plugin ships its own home card under a DIFFERENT id.
    registerWidgetComponent(pluginId, `${pluginId}.owned-home`, () => null);
    const serverDecls: PluginWidgetDeclaration[] = [
      {
        id: `${pluginId}.owned-home`,
        pluginId,
        slot: "home",
        label: "Owned card",
        icon: "Star",
      },
    ];

    const resolved = resolveWidgetsForSlot(
      "home",
      [{ id: pluginId, enabled: true, isActive: true }],
      serverDecls,
    );

    // The plugin's own declaration resolves…
    const owned = resolved.find(
      (r) => r.declaration.id === `${pluginId}.owned-home`,
    );
    expect(owned).toBeTruthy();
    expect(owned?.declaration.label).toBe("Owned card");

    // …and the stale generic default-sink fallback row for the same plugin is
    // suppressed (no duplicate home tile during migration).
    expect(
      resolved.find((r) => r.declaration.id === `${pluginId}.default-home`),
    ).toBeUndefined();
  });

  it("does NOT suppress the fallback for a server card this host cannot render", () => {
    // Edge case: a plugin migrates by shipping a server `Plugin.widgets` home
    // declaration that has NO registered component and NO uiSpec (e.g. a
    // remote/componentExport-only declaration this build can't render). That
    // declaration is dropped downstream by the `Component || uiSpec` gate, so it
    // must NOT suppress the shared sink — otherwise the plugin would render no
    // home tile at all (a regression vs. the pre-refactor behavior).
    const legacyRow = LEGACY_DEFAULT_HOME_WIDGET_SINK_OPTINS[1];
    const pluginId = legacyRow.pluginId;

    const unrenderableServerDecls: PluginWidgetDeclaration[] = [
      {
        id: `${pluginId}.remote-only`,
        pluginId,
        slot: "home",
        label: "Remote-only card",
        icon: "Cloud",
        // no uiSpec, and no component is registered for this id
      },
    ];

    const resolved = resolveWidgetsForSlot(
      "home",
      [{ id: pluginId, enabled: true, isActive: true }],
      unrenderableServerDecls,
    );

    // The unrenderable server card does not resolve…
    expect(
      resolved.find((r) => r.declaration.id === `${pluginId}.remote-only`),
    ).toBeUndefined();
    // …so the shared default-sink fallback still renders (plugin keeps a tile).
    const fallback = resolved.find(
      (r) => r.declaration.id === `${pluginId}.default-home`,
    );
    expect(fallback).toBeTruthy();
    expect(fallback?.defaultWidgetSink).toBe(legacyRow.defaultWidget);
  });

  it("does NOT suppress a renderable uiSpec declaration that also names a defaultWidget", () => {
    // The migration guard must only drop the sink-only fallback, never a real
    // card. A server declaration that carries BOTH a `uiSpec` (renderable) and a
    // `defaultWidget` marks its plugin as having an own card; the guard must not
    // then suppress that very declaration on the `!Component && defaultWidget`
    // path — it renders via its `uiSpec`.
    const pluginId = "uispec-plus-sink";
    const serverDecls: PluginWidgetDeclaration[] = [
      {
        id: `${pluginId}.card`,
        pluginId,
        slot: "home",
        label: "UiSpec card",
        icon: "Star",
        defaultWidget: "activity",
        uiSpec: {
          root: "root",
          state: {},
          elements: {
            root: { type: "Text", props: { text: "hi" }, children: [] },
          },
        },
      },
    ];

    const resolved = resolveWidgetsForSlot(
      "home",
      [{ id: pluginId, enabled: true, isActive: true }],
      serverDecls,
    );

    const card = resolved.find((r) => r.declaration.id === `${pluginId}.card`);
    expect(card).toBeTruthy();
    expect(card?.declaration.uiSpec).toBeDefined();
  });

  it("does NOT suppress a server-provided shared-sink widget alongside an owned card", () => {
    // The migration guard targets ONLY the built-in legacy `.default-home`
    // fallback rows. A plugin may intentionally ship both an owned home card and
    // a separate server-declared shared-sink widget via its own `Plugin.widgets`
    // — that server sink declaration is a deliberate choice and must still
    // render even though the plugin now has an owned card.
    const pluginId = "owned-plus-server-sink";
    registerWidgetComponent(pluginId, `${pluginId}.owned`, () => null);

    const serverDecls: PluginWidgetDeclaration[] = [
      {
        id: `${pluginId}.owned`,
        pluginId,
        slot: "home",
        label: "Owned card",
        icon: "Star",
      },
      {
        // A second, server-provided declaration that opts into a shared sink
        // (no component, no uiSpec) — NOT a built-in legacy fallback row.
        id: `${pluginId}.extra-sink`,
        pluginId,
        slot: "home",
        label: "Extra sink",
        icon: "Bell",
        defaultWidget: "notifications",
      },
    ];

    const resolved = resolveWidgetsForSlot(
      "home",
      [{ id: pluginId, enabled: true, isActive: true }],
      serverDecls,
    );

    // Both the owned card and the intentional server sink widget render.
    expect(
      resolved.find((r) => r.declaration.id === `${pluginId}.owned`),
    ).toBeTruthy();
    const sink = resolved.find(
      (r) => r.declaration.id === `${pluginId}.extra-sink`,
    );
    expect(sink).toBeTruthy();
    expect(sink?.defaultWidgetSink).toBe("notifications");
  });
});
