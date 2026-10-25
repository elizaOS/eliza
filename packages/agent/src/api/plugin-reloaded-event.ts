/**
 * Builds the `plugin_reloaded` `view:event` broadcast — the shared payload shape
 * (plugin name, source directory, originating source) that tells dashboard
 * clients to refresh a hot-reloaded plugin's views.
 */
export const PLUGIN_RELOADED_VIEW_EVENT_TYPE = "plugin_reloaded";

export interface PluginReloadedViewEventInput {
  pluginName: string;
  directory: string;
  source: string;
}

export function buildPluginReloadedViewEvent({
  pluginName,
  directory,
  source,
}: PluginReloadedViewEventInput): {
  type: "view:event";
  viewEventType: typeof PLUGIN_RELOADED_VIEW_EVENT_TYPE;
  payload: {
    pluginName: string;
    directory: string;
    source: string;
  };
} {
  return {
    type: "view:event",
    viewEventType: PLUGIN_RELOADED_VIEW_EVENT_TYPE,
    payload: {
      pluginName,
      directory,
      source,
    },
  };
}
