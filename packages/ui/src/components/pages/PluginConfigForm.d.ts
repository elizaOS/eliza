import type { PluginInfo } from "../../api";
/**
 * Hook that manages the "allow all / specific chats" toggle state.
 * Mode is explicit (not derived from field value) so clearing the field
 * doesn't flip the toggle. Returns the mode, a toggle handler, and
 * hiddenKeys for PluginConfigForm.
 */
export declare function useTelegramChatMode(plugin: PluginInfo, pluginConfigs: Record<string, Record<string, string>>, onParamChange: (pluginId: string, paramKey: string, value: string) => void): {
    allowAll: boolean;
    toggle: (next: boolean) => void;
    hiddenKeys: Set<string> | undefined;
};
export declare function TelegramChatModeToggle({ allowAll, onToggle, }: {
    allowAll: boolean;
    onToggle: (next: boolean) => void;
}): import("react/jsx-runtime").JSX.Element;
/** Wraps PluginConfigForm with the Telegram chat mode toggle + hidden keys. */
export declare function TelegramPluginConfig({ plugin, pluginConfigs, onParamChange, }: {
    plugin: PluginInfo;
    pluginConfigs: Record<string, Record<string, string>>;
    onParamChange: (pluginId: string, paramKey: string, value: string) => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function PluginConfigForm({ plugin, pluginConfigs, onParamChange, hiddenKeys, }: {
    plugin: PluginInfo;
    pluginConfigs: Record<string, Record<string, string>>;
    onParamChange: (pluginId: string, paramKey: string, value: string) => void;
    hiddenKeys?: Set<string>;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=PluginConfigForm.d.ts.map