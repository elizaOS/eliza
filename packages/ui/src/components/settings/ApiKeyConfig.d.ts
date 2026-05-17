import { type PluginParamDef } from "../../api";
import type { ConfigUiHint } from "../../types";
interface ProviderPlugin {
    id: string;
    name: string;
    parameters: PluginParamDef[];
    configured: boolean;
    configUiHints?: Record<string, ConfigUiHint>;
    enabled: boolean;
    category: string;
    /**
     * Server-side validation results for the currently-saved config.
     * Populated by `validatePluginConfig` against the live `process.env`
     * + saved `config.env.X`. Surfaced inline above the form so users
     * see "your saved OpenRouter key doesn't match sk-or-…" without
     * having to first edit the field.
     */
    validationWarnings?: Array<{
        field: string;
        message: string;
    }>;
    validationErrors?: Array<{
        field: string;
        message: string;
    }>;
}
export interface ApiKeyConfigProps {
    selectedProvider: ProviderPlugin | null;
    pluginSaving: Set<string>;
    pluginSaveSuccess: Set<string>;
    handlePluginConfigSave: (pluginId: string, values: Record<string, string>) => void;
    loadPlugins: () => Promise<void>;
}
export declare function ApiKeyConfig({ selectedProvider, pluginSaving, pluginSaveSuccess, handlePluginConfigSave, loadPlugins, }: ApiKeyConfigProps): import("react/jsx-runtime").JSX.Element | null;
export {};
//# sourceMappingURL=ApiKeyConfig.d.ts.map