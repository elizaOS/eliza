import type { SubscriptionProviderStatus } from "@elizaos/shared";
import { type ComponentType } from "react";
import type { PluginParamDef } from "../../api";
import type { ConfigUiHint } from "../../types";
import type { ProviderCategory, ProviderStatus } from "./ProviderCard";
import type { ProviderPanelId } from "./useProviderSelection";
export interface PluginInfo {
    id: string;
    name: string;
    category: string;
    enabled: boolean;
    configured: boolean;
    parameters: PluginParamDef[];
    configUiHints?: Record<string, ConfigUiHint>;
}
export interface ProviderListEntry {
    id: ProviderPanelId;
    icon: ComponentType<{
        className?: string;
        "aria-hidden"?: boolean;
    }>;
    label: string;
    category: ProviderCategory;
    status: ProviderStatus;
    current: boolean;
}
export interface ApiProviderChoice {
    id: string;
    label: string;
    provider: PluginInfo;
}
export declare function normalizeAiProviderPluginId(value: string): string;
export declare function sortAiProviders(plugins: PluginInfo[]): PluginInfo[];
export declare function computeAvailableProviderIds(allAiProviders: PluginInfo[]): Set<string>;
interface UseProviderEntriesArgs {
    allAiProviders: PluginInfo[];
    elizaCloudConnected: boolean;
    cloudCallsDisabled: boolean;
    isCloudSelected: boolean;
    resolvedSelectedId: string | null;
    subscriptionStatus: SubscriptionProviderStatus[];
    anthropicCliDetected: boolean;
    t: (key: string, vars?: Record<string, unknown>) => string;
}
export interface UseProviderEntriesResult {
    apiProviderChoices: ApiProviderChoice[];
    providerEntries: ProviderListEntry[];
}
export declare function useProviderEntries({ allAiProviders, elizaCloudConnected, cloudCallsDisabled, isCloudSelected, resolvedSelectedId, subscriptionStatus, anthropicCliDetected, t, }: UseProviderEntriesArgs): UseProviderEntriesResult;
export {};
//# sourceMappingURL=useProviderEntries.d.ts.map