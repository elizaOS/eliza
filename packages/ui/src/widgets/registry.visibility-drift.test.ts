/**
 * Drift guard for declaration-driven widget visibility (#12090 item 9).
 *
 * Widget visibility used to be gated on two hardcoded plugin-id string sets
 * (`ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS` / `BUILTIN_WIDGET_FALLBACK_
 * PLUGIN_IDS`). Those sets drifted against declaration `pluginId`s (the classic
 * `todo` vs `todos` split), silently dropping or resurrecting widgets. Behavior
 * is now carried on each declaration's `visibility` field and resolved by
 * `widgetVisibilityClass`. These tests assert:
 *   1. No hardcoded pluginId allow/block set survives in the resolver source.
 *   2. Every non-snapshot built-in declaration declares its class explicitly.
 *   3. The `visibility` field, not a set, drives `isWidgetEnabled` for the
 *      no-snapshot (fallback) and always-visible cases — including the exact
 *      `todo`-vs-`todos` drift that motivated the audit item.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_WIDGET_DECLARATIONS,
  registerBuiltinWidgetDeclarations,
  registerWidgetComponent,
  resolveWidgetsForSlot,
  widgetVisibilityClass,
} from "./registry";
import type { PluginWidgetDeclaration } from "./types";

const registrySource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "registry.ts"),
  "utf8",
);

describe("widget visibility drift guard (#12090 item 9)", () => {
  it("removed the hardcoded plugin-id visibility allow/block sets", () => {
    // The coupling this audit item targets: a hardcoded `Set<pluginId>` that had
    // to be hand-synced with declaration pluginIds. Its removal (outside of
    // reference comments) is what keeps `todo`/`todos` from drifting again.
    const executableRefs = registrySource.split("\n").filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return (
        line.includes("ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS") ||
        line.includes("BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS")
      );
    });
    expect(executableRefs).toEqual([]);
  });

  it("derives visibility from each declaration's own `visibility` field", () => {
    // The always/fallback classes must be declaration-declared, never inferred
    // from a name list. Server-sourced declarations stay snapshot-gated.
    const always = BUILTIN_WIDGET_DECLARATIONS.filter(
      (d) => widgetVisibilityClass(d, "builtin") === "always",
    );
    const fallback = BUILTIN_WIDGET_DECLARATIONS.filter(
      (d) => widgetVisibilityClass(d, "builtin") === "fallback",
    );
    // Every non-snapshot builtin must carry an explicit `visibility` field (no
    // implicit set membership), and there must actually be some of each class
    // (guards an accidental "everything became snapshot" refactor).
    for (const d of [...always, ...fallback]) {
      expect(d.visibility).toBeDefined();
    }
    expect(always.length).toBeGreaterThan(0);
    expect(fallback.length).toBeGreaterThan(0);

    // A server declaration is always snapshot-gated regardless of its flag.
    expect(
      widgetVisibilityClass(
        {
          id: "x.y",
          pluginId: "x",
          slot: "home",
          label: "X",
          visibility: "always",
        },
        "server",
      ),
    ).toBe("snapshot");
  });

  it("resolves the Todos home widget with NO plugin snapshot (todo-vs-todos drift regression)", () => {
    // The drift bug: the hardcoded fallback set held `"todo"` while the app
    // manifest plugin id is `todos`. The declaration uses pluginId `todo` and
    // now carries `visibility: "fallback"`, so it resolves on an empty snapshot
    // via its own field — no id set to fall out of sync.
    const todoDecl = BUILTIN_WIDGET_DECLARATIONS.find(
      (d) => d.id === "todo.items" && d.slot === "home",
    );
    if (!todoDecl) throw new Error("missing todo home widget declaration");
    expect(todoDecl?.pluginId).toBe("todo");
    expect(widgetVisibilityClass(todoDecl, "builtin")).toBe("fallback");

    const resolved = resolveWidgetsForSlot("home", []);
    const todos = resolved.find((r) => r.declaration.id === "todo.items");
    expect(todos).toBeTruthy();
    expect(todos?.Component).toBeTruthy();
  });

  it("hides a fallback widget when its plugin is present-but-disabled in the snapshot", () => {
    // Fallback means "show when the snapshot is missing/omits it", NOT "ignore an
    // explicit disable". An operator disabling the todo plugin must still win.
    const resolved = resolveWidgetsForSlot("home", [
      { id: "todo", enabled: false, isActive: false },
    ]);
    expect(
      resolved.find((r) => r.declaration.id === "todo.items"),
    ).toBeUndefined();
  });

  it("keeps always-visible core widgets on an empty snapshot but honors explicit disable", () => {
    // Needs-attention is backed by the core ApprovalService, not a loadable
    // plugin — the canonical `always` core surface with no snapshot entry.
    const emptyResolved = resolveWidgetsForSlot("home", []);
    expect(
      emptyResolved.find((r) => r.declaration.id === "needs-attention.pending"),
    ).toBeTruthy();

    // Calendar is `always` but IS backed by a real loadable plugin, so an
    // explicit present+disabled snapshot entry still hides it.
    const calendarDecl = BUILTIN_WIDGET_DECLARATIONS.find(
      (d) => d.slot === "home" && d.pluginId === "calendar",
    );
    if (!calendarDecl)
      throw new Error("missing calendar home widget declaration");
    expect(widgetVisibilityClass(calendarDecl, "builtin")).toBe("always");
    const disabled = resolveWidgetsForSlot("home", [
      { id: "calendar", enabled: false, isActive: false },
    ]);
    expect(
      disabled.find((r) => r.declaration.pluginId === "calendar"),
    ).toBeUndefined();
  });

  it("snapshot-class builtins stay hidden until their plugin is present+active", () => {
    // A default (snapshot) builtin — health — must NOT appear on an empty
    // snapshot, and must appear once its plugin is active.
    const healthDecl = BUILTIN_WIDGET_DECLARATIONS.find(
      (d) => d.slot === "home" && d.pluginId === "health",
    );
    if (!healthDecl) throw new Error("missing health home widget declaration");
    expect(widgetVisibilityClass(healthDecl, "builtin")).toBe("snapshot");

    const empty = resolveWidgetsForSlot("home", []);
    expect(
      empty.find((r) => r.declaration.pluginId === "health"),
    ).toBeUndefined();

    const active = resolveWidgetsForSlot("home", [
      { id: "health", enabled: true, isActive: true },
    ]);
    expect(
      active.find((r) => r.declaration.pluginId === "health"),
    ).toBeTruthy();
  });

  it("still honors third-party `fallbackPluginIds` for declarations without a `visibility` flag", () => {
    // Back-compat: registerBuiltinWidgetDeclarations({ fallbackPluginIds })
    // continues to promote flag-less declarations to fallback behavior.
    expect(registrySource).toContain("EXTERNAL_FALLBACK_PLUGIN_IDS");
    expect(registrySource).toContain("fallbackPluginIds");

    const originalLength = BUILTIN_WIDGET_DECLARATIONS.length;
    registerWidgetComponent(
      "external-fallback-test",
      "external-fallback-test.card",
      () => null,
    );
    try {
      registerBuiltinWidgetDeclarations(
        [
          {
            id: "external-fallback-test.card",
            pluginId: "external-fallback-test",
            slot: "home",
            label: "External fallback test",
            defaultEnabled: true,
          },
        ],
        { fallbackPluginIds: ["external-fallback-test"] },
      );

      const resolved = resolveWidgetsForSlot("home", []);
      expect(
        resolved.find(
          (r) => r.declaration.id === "external-fallback-test.card",
        ),
      ).toBeTruthy();
    } finally {
      BUILTIN_WIDGET_DECLARATIONS.splice(originalLength);
    }
  });

  it("keeps a server widget on an empty snapshot but hides it when a non-empty snapshot omits its plugin", () => {
    // Server declarations are snapshot-gated, and the refactor must preserve the
    // exact pre-#12637 semantics:
    //   - empty snapshot        -> shown (the declaration may have arrived before
    //                              its snapshot entry; don't hide on that race)
    //   - non-empty, omits it   -> hidden (the plugin is genuinely absent)
    //   - present + active      -> shown
    registerWidgetComponent("srv-omit-test", "srv-omit-test.card", () => null);
    const serverDecls: PluginWidgetDeclaration[] = [
      {
        id: "srv-omit-test.card",
        pluginId: "srv-omit-test",
        slot: "home",
        label: "Server omit test",
      },
    ];

    // Empty snapshot: race exemption — shown.
    expect(
      resolveWidgetsForSlot("home", [], serverDecls).find(
        (r) => r.declaration.id === "srv-omit-test.card",
      ),
    ).toBeTruthy();

    // Non-empty snapshot that OMITS the plugin: hidden (this is the case the
    // refactor silently flipped to "shown"; it is restored here).
    expect(
      resolveWidgetsForSlot(
        "home",
        [{ id: "some-other-plugin", enabled: true, isActive: true }],
        serverDecls,
      ).find((r) => r.declaration.id === "srv-omit-test.card"),
    ).toBeUndefined();

    // Present + active: shown.
    expect(
      resolveWidgetsForSlot(
        "home",
        [{ id: "srv-omit-test", enabled: true, isActive: true }],
        serverDecls,
      ).find((r) => r.declaration.id === "srv-omit-test.card"),
    ).toBeTruthy();
  });
});
