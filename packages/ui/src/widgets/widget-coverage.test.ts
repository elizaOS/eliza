/**
 * Coverage gate asserting every declared widget slot keeps a bundled component +
 * declaration, so a refactor cannot silently drop one. Reads the source tree, no
 * runtime.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_WIDGET_DECLARATIONS,
  resolveWidgetsForSlot,
  type WidgetPluginState,
} from "./registry";
import { type PluginWidgetDeclaration, WIDGET_SLOTS } from "./types";

// #9143 — per-plugin home-widget coverage gate.
//
// The contract: every plugin with an `elizaos.app` manifest is frontpage-aware
// — it resolves a rendered `home`-slot widget (its own bundled component OR
// the shared activity sink) via `resolveWidgetsForSlot`, or it declares a
// notifications/messages default sink. The notification-sink declarations
// render no tile of their own (the pinned NotificationsHomeCenter aggregates
// the notification store for every producer), so for them the declaration is
// the participation record. This enumerates the manifests directly instead of
// keeping a hand-written short list, so a future app plugin without a
// frontpage presence fails CI here.
//
// IDs match the plugin list's normalization: strip the npm scope, then strip
// either `plugin-` or legacy `app-` prefixes.

function enabled(id: string): WidgetPluginState {
  return { id, enabled: true, isActive: true };
}

interface AppManifestPlugin {
  id: string;
  packageName: string;
  packageDir: string;
}

function repoRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
}

function pluginIdFromPackageName(packageName: string): string {
  const withoutScope = packageName.startsWith("@")
    ? (packageName.split("/")[1] ?? packageName)
    : packageName;
  if (withoutScope.startsWith("plugin-")) {
    return withoutScope.slice("plugin-".length);
  }
  if (withoutScope.startsWith("app-")) {
    return withoutScope.slice("app-".length);
  }
  return withoutScope;
}

function readAppManifestPlugins(): AppManifestPlugin[] {
  const pluginsDir = path.join(repoRoot(), "plugins");
  return readdirSync(pluginsDir)
    .flatMap((packageDir): AppManifestPlugin[] => {
      const packageJsonPath = path.join(pluginsDir, packageDir, "package.json");
      if (!existsSync(packageJsonPath)) return [];
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
        name?: string;
        elizaos?: { app?: unknown };
      };
      if (!pkg.name || !pkg.elizaos?.app) return [];
      return [
        {
          id: pluginIdFromPackageName(pkg.name),
          packageName: pkg.name,
          packageDir,
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function withTempDeclaration<T>(decl: PluginWidgetDeclaration, fn: () => T): T {
  BUILTIN_WIDGET_DECLARATIONS.push(decl);
  try {
    return fn();
  } finally {
    const i = BUILTIN_WIDGET_DECLARATIONS.indexOf(decl);
    if (i >= 0) BUILTIN_WIDGET_DECLARATIONS.splice(i, 1);
  }
}

describe("home-widget per-plugin coverage gate (#9143)", () => {
  const appManifestPlugins = readAppManifestPlugins();

  it("discovers app-manifest plugins from package.json", () => {
    // Ratcheted 28 → 26 (#11036): plugin-companion was removed by #10434 and
    // plugin-elizamaker by c3944534b0 — both intentional deletions that shrank
    // the app-manifest set without this floor being updated.
    expect(appManifestPlugins.length).toBeGreaterThanOrEqual(26);
  });

  // A notifications/messages sink declaration renders no tile — its content
  // surfaces through the pinned NotificationsHomeCenter — so the declaration
  // itself is the plugin's frontpage participation record.
  function declaresNotificationSink(pluginId: string): boolean {
    return BUILTIN_WIDGET_DECLARATIONS.some(
      (decl) =>
        decl.pluginId === pluginId &&
        decl.slot === "home" &&
        (decl.defaultWidget === "notifications" ||
          decl.defaultWidget === "messages"),
    );
  }

  it("keeps every app-manifest plugin frontpage-aware (rendered widget or notification-sink declaration)", () => {
    const missing: string[] = [];

    for (const plugin of appManifestPlugins) {
      const own = resolveWidgetsForSlot("home", [enabled(plugin.id)]).filter(
        (r) => r.declaration.pluginId === plugin.id,
      );
      const rendered = own.filter((entry) => entry.Component !== null);
      if (rendered.length === 0 && !declaresNotificationSink(plugin.id)) {
        missing.push(
          `${plugin.id} (${plugin.packageName}, ${plugin.packageDir})`,
        );
      }
    }

    expect(missing).toEqual([]);
  });

  it("reports the current own-widget/default-sink split", () => {
    const coverage = appManifestPlugins.map((plugin) => {
      const entries = resolveWidgetsForSlot("home", [
        enabled(plugin.id),
      ]).filter(
        (r) => r.declaration.pluginId === plugin.id && r.Component !== null,
      );
      return {
        id: plugin.id,
        own: entries.some((entry) => !entry.defaultWidgetSink),
        defaultSink: entries.some((entry) => Boolean(entry.defaultWidgetSink)),
        notificationSink: declaresNotificationSink(plugin.id),
      };
    });

    const ownWidget = coverage.filter((entry) => entry.own).length;
    const defaultSink = coverage.filter(
      (entry) => !entry.own && entry.defaultSink,
    ).length;
    const notificationParticipants = coverage.filter(
      (entry) => !entry.own && !entry.defaultSink && entry.notificationSink,
    ).length;

    expect(ownWidget + defaultSink + notificationParticipants).toBe(
      appManifestPlugins.length,
    );
    expect(ownWidget).toBeGreaterThanOrEqual(5);
  });

  it("red/green control: no declaration fails, default-sink opt-in passes", () => {
    const pluginId = "coverage-red-control";
    expect(
      resolveWidgetsForSlot("home", [enabled(pluginId)]).some(
        (r) => r.declaration.pluginId === pluginId,
      ),
    ).toBe(false);

    withTempDeclaration(
      {
        id: `${pluginId}.default-home`,
        pluginId,
        slot: "home",
        label: "Coverage Red Control",
        defaultWidget: "activity",
      },
      () => {
        const resolved = resolveWidgetsForSlot("home", [enabled(pluginId)]);
        const entry = resolved.find((r) => r.declaration.pluginId === pluginId);
        expect(entry?.Component).toBeTruthy();
        expect(entry?.defaultWidgetSink).toBe("activity");
      },
    );
  });
});

// #9304 — chat-sidebar slot coverage gate.
//
// The right-rail chat-sidebar widgets are bundled (not auto-discovered from
// manifests), so a refactor that drops one of their declarations would silently
// remove it from the live chat surface with no failing test. This gate pins the
// expected set: every id must resolve with a rendered Component. Dropping one
// fails CI here.
describe("chat-sidebar slot coverage gate (#9304)", () => {
  // The bundled plugins whose widgets target the chat-sidebar rail.
  const SIDEBAR_PLUGINS: WidgetPluginState[] = [
    enabled("agent-orchestrator"),
    enabled("browser-workspace"),
    enabled("music-player"),
  ];
  // Every chat-sidebar widget id that must remain wired.
  const EXPECTED_SIDEBAR_WIDGET_IDS = [
    "agent-orchestrator.apps",
    "agent-orchestrator.activity",
    "browser.status",
    "music-player.stream",
  ] as const;

  it("resolves every expected chat-sidebar widget with a rendered component", () => {
    const resolved = resolveWidgetsForSlot("chat-sidebar", SIDEBAR_PLUGINS);
    const rendered = new Set(
      resolved.filter((r) => r.Component !== null).map((r) => r.declaration.id),
    );
    const missing = EXPECTED_SIDEBAR_WIDGET_IDS.filter(
      (id) => !rendered.has(id),
    );
    expect(missing).toEqual([]);
  });
});

// #9448 — dead slot cleanup gate.
describe("widget slot contract (#9448)", () => {
  it("keeps the active widget slot list limited to supported surfaces", () => {
    expect(WIDGET_SLOTS).toEqual([
      "chat-sidebar",
      "character",
      "nav-page",
      "home",
    ]);
  });

  it("keeps bundled widget declarations off retired slots", () => {
    const active = new Set<string>(WIDGET_SLOTS);
    const retired = BUILTIN_WIDGET_DECLARATIONS.filter(
      (decl) => !active.has(decl.slot),
    ).map((decl) => `${decl.pluginId}/${decl.id}:${decl.slot}`);

    expect(retired).toEqual([]);
  });
});
