/**
 * Server-side plugin widget declarations.
 *
 * Maps plugin IDs to their widget metadata. This is the authoritative source
 * for widget declarations until upstream elizaOS adds a `widgets` field to the
 * Plugin type. When that happens, this map becomes a fallback for plugins
 * that haven't adopted the new field yet.
 *
 * Widget types are intentionally kept as plain objects (not imported from
 * app-core) to avoid circular dependencies between server and client packages.
 */

export interface PluginWidgetDeclarationServer {
  id: string;
  pluginId: string;
  slot:
    | "chat-sidebar"
    | "chat-inline"
    | "wallet"
    | "browser"
    | "heartbeats"
    | "character"
    | "settings"
    | "nav-page";
  label: string;
  icon?: string;
  order?: number;
  defaultEnabled?: boolean;
  navGroup?: string;
}

/**
 * Static map of plugin widget declarations.
 * Key: plugin ID. Value: array of widget declarations.
 */
export const PLUGIN_WIDGET_MAP: Record<
  string,
  PluginWidgetDeclarationServer[]
> = {
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

/** Resolve widget declarations for a plugin by ID. */
export function getPluginWidgets(
  pluginId: string,
): PluginWidgetDeclarationServer[] {
  return PLUGIN_WIDGET_MAP[pluginId] ?? [];
}
