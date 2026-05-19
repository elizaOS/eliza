import type { LinkedAccountProviderId, ModelOption, SubscriptionProviderStatus } from "@elizaos/shared";
import type { Dispatch, SetStateAction } from "react";
import type { PluginParamDef } from "../../api";
import type { SUBSCRIPTION_PROVIDER_SELECTIONS, SubscriptionProviderSelectionId } from "../../providers";
import type { ConfigUiHint } from "../../types";
import type { CloudModelSchema } from "./cloud-model-schema";
type SubscriptionProviderSelection = (typeof SUBSCRIPTION_PROVIDER_SELECTIONS)[number];
interface PluginInfo {
    id: string;
    name: string;
    category: string;
    enabled: boolean;
    configured: boolean;
    parameters: PluginParamDef[];
    configUiHints?: Record<string, ConfigUiHint>;
}
export declare function LocalProviderPanel({ cloudCallsDisabled, routingModeSaving, onSelectLocalOnly, }: {
    cloudCallsDisabled: boolean;
    routingModeSaving: boolean;
    onSelectLocalOnly: () => void;
}): import("react/jsx-runtime").JSX.Element;
export interface CloudPanelProps {
    cloudCallsDisabled: boolean;
    isCloudSelected: boolean;
    routingModeSaving: boolean;
    onSelectCloud: () => void;
    elizaCloudConnected: boolean;
    largeModelOptions: ModelOption[];
    cloudModelSchema: CloudModelSchema | null;
    modelValues: {
        values: Record<string, unknown>;
        setKeys: Set<string>;
    };
    currentLargeModel: string;
    modelSaving: boolean;
    modelSaveSuccess: boolean;
    onModelFieldChange: (key: string, value: unknown) => void;
    localEmbeddings: boolean;
    onToggleLocalEmbeddings: (next: boolean) => void;
}
export declare function CloudPanel({ cloudCallsDisabled, isCloudSelected, routingModeSaving, onSelectCloud, elizaCloudConnected, largeModelOptions, cloudModelSchema, modelValues, currentLargeModel, modelSaving, modelSaveSuccess, onModelFieldChange, localEmbeddings, onToggleLocalEmbeddings, }: CloudPanelProps): import("react/jsx-runtime").JSX.Element;
export interface SubscriptionPanelProps {
    selection: SubscriptionProviderSelection;
    description: string;
    visibleProviderPanelId: string;
    resolvedSelectedId: string | null;
    cloudCallsDisabled: boolean;
    subscriptionStatus: SubscriptionProviderStatus[];
    anthropicConnected: boolean;
    setAnthropicConnected: Dispatch<SetStateAction<boolean>>;
    anthropicCliDetected: boolean;
    openaiConnected: boolean;
    setOpenaiConnected: Dispatch<SetStateAction<boolean>>;
    onSelectSubscription: (providerId: SubscriptionProviderSelectionId, activate?: boolean) => Promise<void>;
    loadSubscriptionStatus: () => Promise<void>;
}
export declare function SubscriptionPanel({ selection, description, visibleProviderPanelId, resolvedSelectedId, cloudCallsDisabled, subscriptionStatus, anthropicConnected, setAnthropicConnected, anthropicCliDetected, openaiConnected, setOpenaiConnected, onSelectSubscription, loadSubscriptionStatus, }: SubscriptionPanelProps): import("react/jsx-runtime").JSX.Element;
export interface ApiKeyPanelProps {
    selectedProvider: PluginInfo;
    panelLabel: string;
    visibleProviderPanelId: string;
    resolvedSelectedId: string | null;
    cloudCallsDisabled: boolean;
    selectedPanelAccountProvider: LinkedAccountProviderId | null;
    onSwitchProvider: (id: string) => void;
    pluginSaving: Set<string>;
    pluginSaveSuccess: Set<string>;
    handlePluginConfigSave: (pluginId: string, values: Record<string, string>) => void;
    loadPlugins: () => Promise<void>;
}
export declare function ApiKeyPanel({ selectedProvider, panelLabel, visibleProviderPanelId, resolvedSelectedId, cloudCallsDisabled, selectedPanelAccountProvider, onSwitchProvider, pluginSaving, pluginSaveSuccess, handlePluginConfigSave, loadPlugins, }: ApiKeyPanelProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=ProviderPanels.d.ts.map