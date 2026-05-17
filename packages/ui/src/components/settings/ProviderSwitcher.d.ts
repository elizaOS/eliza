import { type PluginInfo } from "./useProviderEntries";

interface ProviderSwitcherProps {
  elizaCloudConnected?: boolean;
  plugins?: PluginInfo[];
  pluginSaving?: Set<string>;
  pluginSaveSuccess?: Set<string>;
  loadPlugins?: () => Promise<void>;
  handlePluginConfigSave?: (
    pluginId: string,
    values: Record<string, unknown>,
  ) => void | Promise<void>;
}
export declare function ProviderSwitcher(
  props?: ProviderSwitcherProps,
): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ProviderSwitcher.d.ts.map
