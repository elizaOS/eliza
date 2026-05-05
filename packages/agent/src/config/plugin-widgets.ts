/**
 * Server-side plugin widget declarations.
 *
 * Two sources merge here:
 *   1. The plugin's own `widgets` field on its `Plugin` instance (canonical).
 *   2. The static `PLUGIN_WIDGET_MAP` below, kept as a fallback for plugins
 *      that haven't migrated to declaring widgets on the Plugin instance yet.
 *
 * TODO: Migrate each entry into the owning plugin's `widgets` field, then
 * delete its row from `PLUGIN_WIDGET_MAP`.
 */

import type { Plugin, PluginWidgetDeclaration } from "@elizaos/core";

export type PluginWidgetDeclarationServer = PluginWidgetDeclaration;

/**
 * Static map of plugin widget declarations.
 * Key: plugin ID. Value: array of widget declarations.
 */
export const PLUGIN_WIDGET_MAP: Record<string, PluginWidgetDeclaration[]> = {
  lifeops: [
    {
      id: "lifeops.overview",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "LifeOps Overview",
      icon: "Sparkles",
      order: 90,
      defaultEnabled: true,
    },
    {
      id: "lifeops.google",
      pluginId: "lifeops",
      slot: "chat-sidebar",
      label: "Google Services",
      icon: "Plug2",
      order: 150,
      defaultEnabled: true,
    },
  ],
  "agent-orchestrator": [
    {
      id: "agent-orchestrator.apps",
      pluginId: "agent-orchestrator",
      slot: "chat-sidebar",
      label: "App Runs",
      icon: "Activity",
      order: 150,
      defaultEnabled: true,
    },
    {
      id: "agent-orchestrator.activity",
      pluginId: "agent-orchestrator",
      slot: "chat-sidebar",
      label: "Activity",
      icon: "Activity",
      order: 300,
      defaultEnabled: true,
    },
  ],
};

/** Strip common scope/prefix to compare a Plugin.name against a PluginEntry.id. */
function normalizePluginIdentity(value: string): string {
  let v = value.trim();
  if (v.startsWith("@")) {
    const slash = v.indexOf("/");
    if (slash > 0) v = v.slice(slash + 1);
  }
  if (v.startsWith("plugin-")) v = v.slice("plugin-".length);
  if (v.startsWith("app-")) v = v.slice("app-".length);
  return v;
}

/**
 * Resolve widget declarations for a plugin by id, merging:
 *   - the plugin instance's own `widgets` field (when a runtime plugin list is
 *     supplied and a match is found), and
 *   - the static `PLUGIN_WIDGET_MAP` fallback.
 *
 * Declarations from the plugin instance take precedence; static-map entries
 * with the same `(pluginId, id)` key are dropped.
 */
export function getPluginWidgets(
  pluginId: string,
  runtimePlugins?: ReadonlyArray<Plugin>,
): PluginWidgetDeclaration[] {
  const fromInstance: PluginWidgetDeclaration[] = [];
  if (runtimePlugins && runtimePlugins.length > 0) {
    const normalizedId = normalizePluginIdentity(pluginId);
    const match = runtimePlugins.find(
      (p) => normalizePluginIdentity(p.name) === normalizedId,
    );
    if (match?.widgets && match.widgets.length > 0) {
      fromInstance.push(...match.widgets);
    }
  }

  const fallback = PLUGIN_WIDGET_MAP[pluginId] ?? [];
  if (fromInstance.length === 0) {
    return [...fallback];
  }

  const seen = new Set(fromInstance.map((w) => `${w.pluginId}::${w.id}`));
  const merged = [...fromInstance];
  for (const decl of fallback) {
    const key = `${decl.pluginId}::${decl.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(decl);
    }
  }
  return merged;
}
