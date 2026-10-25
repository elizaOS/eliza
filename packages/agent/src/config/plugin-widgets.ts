/**
 * Server-side plugin widget declarations.
 *
 * Widget declarations come from the plugin's own `widgets` field on its
 * `Plugin` instance; `getPluginWidgets` resolves them for a plugin id by
 * matching against the supplied runtime plugin list.
 */

import type { Plugin, PluginWidgetDeclaration } from "@elizaos/core";

export type PluginWidgetDeclarationServer = PluginWidgetDeclaration;

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
 * Resolve widget declarations for a plugin by id from the matching runtime
 * plugin instance's own `widgets` field. Returns an empty list when no runtime
 * plugin list is supplied or no matched plugin declares widgets.
 */
export function getPluginWidgets(
  pluginId: string,
  runtimePlugins?: ReadonlyArray<Plugin>,
): PluginWidgetDeclaration[] {
  if (!runtimePlugins || runtimePlugins.length === 0) {
    return [];
  }
  const normalizedId = normalizePluginIdentity(pluginId);
  const match = runtimePlugins.find(
    (p) => normalizePluginIdentity(p.name) === normalizedId,
  );
  if (match?.widgets && match.widgets.length > 0) {
    return [...match.widgets];
  }
  return [];
}
