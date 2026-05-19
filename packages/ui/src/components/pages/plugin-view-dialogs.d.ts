import type { PluginInfo } from "../../api";
import { type TranslateFn } from "./plugin-list-utils";
type PluginConnectionTestResult = {
    durationMs: number;
    error?: string;
    loading: boolean;
    message?: string;
    success: boolean;
};
interface PluginSettingsDialogProps {
    installPluginLabel: string;
    installProgress: Map<string, {
        message: string;
        phase: string;
    }>;
    installingPlugins: Set<string>;
    pluginConfigs: Record<string, Record<string, string>>;
    pluginSaveSuccess: Set<string>;
    pluginSaving: Set<string>;
    settingsDialogPlugin: PluginInfo | null;
    t: TranslateFn;
    testResults: Map<string, PluginConnectionTestResult>;
    onClose: (pluginId: string) => void;
    onConfigReset: (pluginId: string) => void;
    onConfigSave: (pluginId: string) => Promise<void>;
    onInstallPlugin: (pluginId: string, npmName: string) => Promise<void>;
    onParamChange: (pluginId: string, paramKey: string, value: string) => void;
    onTestConnection: (pluginId: string) => Promise<void>;
    formatDialogTestConnectionLabel: (result?: PluginConnectionTestResult) => string;
    installProgressLabel: (message?: string) => string;
    saveSettingsLabel: string;
    savingLabel: string;
}
export declare function PluginSettingsDialog({ installPluginLabel, installProgress, installingPlugins, pluginConfigs, pluginSaveSuccess, pluginSaving, settingsDialogPlugin, t, testResults, onClose, onConfigReset, onConfigSave, onInstallPlugin, onParamChange, onTestConnection, formatDialogTestConnectionLabel, installProgressLabel, saveSettingsLabel, savingLabel, }: PluginSettingsDialogProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=plugin-view-dialogs.d.ts.map