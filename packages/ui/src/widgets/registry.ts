/**
 * Plugin widget registry.
 *
 * Maintains a static map of plugin widget React components (bundled plugins)
 * and resolves widgets for a given slot based on plugin state.
 *
 * Third-party plugins without bundled React components can provide a `uiSpec`
 * in their widget declaration, which gets rendered by `UiRenderer` via the
 * `WidgetHost` component.
 */

import type { PluginInfo } from "../api/client-types-config";
import type { PluginWidgetDeclaration, WidgetProps, WidgetSlot } from "./types";
import {
  getWidgetComponent,
  registerWidgetComponent,
  seedLegacyWidgets,
} from "./registry-store";
export {
  getWidgetComponent,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";

// -- Bundled widget component imports ----------------------------------------

import { MusicLibraryCharacterWidget } from "../components/character/MusicLibraryCharacterWidget";
import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "../components/chat/widgets/agent-orchestrator";
import { BROWSER_STATUS_WIDGET } from "../components/chat/widgets/browser-status";
import { MUSIC_PLAYER_WIDGET } from "../components/chat/widgets/music-player";
import { TODO_PLUGIN_WIDGETS } from "../components/chat/widgets/todo";
// -- Seed bundled widgets into the registry ----------------------------------

seedLegacyWidgets(AGENT_ORCHESTRATOR_PLUGIN_WIDGETS);
seedLegacyWidgets(TODO_PLUGIN_WIDGETS);
seedLegacyWidgets([BROWSER_STATUS_WIDGET, MUSIC_PLAYER_WIDGET]);
registerWidgetComponent(
  "music-library",
  "music-library.playlists",
  MusicLibraryCharacterWidget,
);

/**
 * Public API for plugins outside app-core to append widget declarations to the
 * built-in fallback list. Declarations appear in the sidebar when the runtime
 * plugin snapshot isn't available or when the plugin is in the fallback set.
 */
export function registerBuiltinWidgetDeclarations(
  declarations: ReadonlyArray<PluginWidgetDeclaration>,
  options?: { fallbackPluginIds?: ReadonlyArray<string> },
): void {
  for (const decl of declarations) {
    BUILTIN_WIDGET_DECLARATIONS.push(decl);
  }
  if (options?.fallbackPluginIds) {
    for (const id of options.fallbackPluginIds) {
      BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.add(id);
    }
  }
}

// -- Built-in widget declarations --------------------------------------------
// These are the widget declarations for bundled plugins. They mirror what
// the server will eventually provide via GET /api/plugins, but are also
// available client-side for zero-config rendering.

export const BUILTIN_WIDGET_DECLARATIONS: PluginWidgetDeclaration[] = [
  // Agent Orchestrator — app runs
  {
    id: "agent-orchestrator.apps",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Apps",
    icon: "Activity",
    order: 150,
    defaultEnabled: true,
  },
  // Agent Orchestrator — activity
  {
    id: "agent-orchestrator.activity",
    pluginId: "agent-orchestrator",
    slot: "chat-sidebar",
    label: "Activity",
    icon: "Activity",
    order: 300,
    defaultEnabled: true,
  },
  // Browser workspace status — surfaces /browser state in the right rail.
  {
    id: BROWSER_STATUS_WIDGET.id,
    pluginId: BROWSER_STATUS_WIDGET.pluginId,
    slot: "chat-sidebar",
    label: "Browser",
    icon: "Globe",
    order: BROWSER_STATUS_WIDGET.order,
    defaultEnabled: BROWSER_STATUS_WIDGET.defaultEnabled,
  },
  {
    id: MUSIC_PLAYER_WIDGET.id,
    pluginId: MUSIC_PLAYER_WIDGET.pluginId,
    slot: "chat-sidebar",
    label: "Music",
    icon: "Music",
    order: MUSIC_PLAYER_WIDGET.order,
    defaultEnabled: MUSIC_PLAYER_WIDGET.defaultEnabled,
  },
  {
    id: "music-library.playlists",
    pluginId: "music-library",
    slot: "character",
    label: "Music Library",
    icon: "ListMusic",
    order: 250,
    defaultEnabled: true,
  },
];

// -- Resolution --------------------------------------------------------------

/** Minimal plugin state needed for widget resolution. */
export type WidgetPluginState = Pick<PluginInfo, "id" | "enabled" | "isActive">;

/**
 * Some bundled widgets intentionally stay visible even when the runtime plugin
 * snapshot omits their feature IDs because the UI has compat-backed data
 * sources for them. Generic todo widgets do not qualify here — Eliza does not
 * ship a runtime todo plugin, and leaving the fallback enabled crowds out the
 * LifeOps-first sidebar with a stale generic tasks panel.
 */
const BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS = new Set([
  "agent-orchestrator",
  // Wallet + browser-workspace are core app-core surfaces, not separately
  // loadable plugins, so their widgets must render even when the runtime
  // plugin snapshot doesn't list them as plugins.
  "wallet",
  "browser-workspace",
]);

const ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS = new Set(["music-player"]);

interface ResolvedWidget {
  declaration: PluginWidgetDeclaration;
  Component: React.ComponentType<WidgetProps> | null;
}

type WidgetDeclarationSource = "builtin" | "server";

function isWidgetEnabled(
  declaration: PluginWidgetDeclaration,
  plugins: readonly WidgetPluginState[],
  source: WidgetDeclarationSource,
): boolean {
  if (
    source === "builtin" &&
    declaration.defaultEnabled !== false &&
    ALWAYS_VISIBLE_BUILTIN_WIDGET_PLUGIN_IDS.has(declaration.pluginId)
  ) {
    return true;
  }

  if (plugins.length === 0) {
    return (
      declaration.defaultEnabled !== false &&
      (source !== "builtin" ||
        BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.has(declaration.pluginId))
    );
  }

  const plugin = plugins.find((p) => p.id === declaration.pluginId);
  if (!plugin) {
    return (
      source === "builtin" &&
      declaration.defaultEnabled !== false &&
      BUILTIN_WIDGET_FALLBACK_PLUGIN_IDS.has(declaration.pluginId)
    );
  }

  return plugin.isActive === true || plugin.enabled !== false;
}

/**
 * Resolve all enabled widgets for a slot.
 *
 * Merges built-in declarations with any server-provided declarations
 * (from PluginInfo.widgets), deduplicating by declaration ID.
 */
export function resolveWidgetsForSlot(
  slot: WidgetSlot,
  plugins: readonly WidgetPluginState[],
  serverDeclarations?: readonly PluginWidgetDeclaration[],
): ResolvedWidget[] {
  // Merge: server declarations override built-in by id
  const declarationMap = new Map<
    string,
    {
      declaration: PluginWidgetDeclaration;
      source: WidgetDeclarationSource;
    }
  >();

  for (const decl of BUILTIN_WIDGET_DECLARATIONS) {
    if (decl.slot === slot) {
      declarationMap.set(`${decl.pluginId}/${decl.id}`, {
        declaration: decl,
        source: "builtin",
      });
    }
  }

  if (serverDeclarations) {
    for (const decl of serverDeclarations) {
      if (decl.slot === slot) {
        declarationMap.set(`${decl.pluginId}/${decl.id}`, {
          declaration: decl,
          source: "server",
        });
      }
    }
  }

  const results: ResolvedWidget[] = [];

  for (const { declaration, source } of declarationMap.values()) {
    if (!isWidgetEnabled(declaration, plugins, source)) continue;

    const Component = getWidgetComponent(declaration.pluginId, declaration.id);

    // Include if we have a React component OR a uiSpec fallback
    if (Component || declaration.uiSpec) {
      results.push({ declaration, Component: Component ?? null });
    }
  }

  results.sort(
    (a, b) => (a.declaration.order ?? 100) - (b.declaration.order ?? 100),
  );

  return results;
}

// -- Backward compatibility --------------------------------------------------
// Re-export a function matching the old `resolveChatSidebarWidgets` signature
// so existing consumers (TasksEventsPanel) work during migration.

import type { ChatSidebarPluginState } from "../components/chat/widgets/types";

export function resolveChatSidebarWidgets(
  plugins: readonly ChatSidebarPluginState[],
) {
  return resolveWidgetsForSlot("chat-sidebar", plugins).map((w) => ({
    id: w.declaration.id,
    pluginId: w.declaration.pluginId,
    order: w.declaration.order ?? 100,
    defaultEnabled: w.declaration.defaultEnabled !== false,
    // biome-ignore lint/style/noNonNullAssertion: chat-sidebar widgets always have bundled components
    Component: w.Component!,
  }));
}
