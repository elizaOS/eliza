import { type SubscriptionProviderSelectionId } from "../../providers";
export type ProviderPanelId = "__cloud__" | "__local__" | string;
interface AiProviderLike {
    id: string;
}
export interface ProviderSelection {
    cloudCallsDisabled: boolean;
    /**
     * True when the host app requires cloud (branding.cloudOnly or
     * mobile runtime is locked to cloud). Local-only switching is blocked.
     */
    cloudRuntimeLocked: boolean;
    routingModeSaving: boolean;
    localEmbeddings: boolean;
    resolvedSelectedId: string | null;
    visibleProviderPanelId: ProviderPanelId;
    isCloudSelected: boolean;
    initializeFromConfig: (cfg: Record<string, unknown>) => void;
    handleSwitchProvider: (newId: string, providerId: string) => Promise<void>;
    handleSelectSubscription: (providerId: SubscriptionProviderSelectionId, activate?: boolean) => Promise<void>;
    handleSelectCloud: () => Promise<void>;
    handleSelectLocalOnly: () => Promise<void>;
    handleToggleLocalEmbeddings: (next: boolean) => Promise<void>;
    handleProviderPanelSelect: (panelId: string) => void;
}
export declare function useProviderSelection(availableProviderIds: Set<string>, notifySelectionFailure: (prefix: string, err: unknown) => void): ProviderSelection;
/**
 * Compute the canonical provider id to send to client.switchProvider() given
 * a panel id. Mirrors the existing normalize-and-look-up flow.
 */
export declare function resolveProviderIdForSwitch(newId: string, aiProviders: AiProviderLike[]): string;
export {};
//# sourceMappingURL=useProviderSelection.d.ts.map