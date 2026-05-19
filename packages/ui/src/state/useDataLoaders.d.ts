/**
 * Data-loading callbacks — extracted from AppContext.
 *
 * Covers: autonomy event merge / replay / append, conversation loaders,
 * BSC trade + steward wrappers, loadInventory, ownerName hydration,
 * character language sync, loadWorkbench, loadUpdateStatus,
 * checkExtensionStatus.
 */
import { type RefObject } from "react";
import { type AgentStatus, type BscTradeExecuteRequest, type BscTradeExecuteResponse, type BscTradePreflightResponse, type BscTradeQuoteRequest, type BscTradeQuoteResponse, type BscTradeTxStatusResponse, type BscTransferExecuteRequest, type BscTransferExecuteResponse, type CharacterData, type Conversation, type ConversationMessage, type ExtensionStatus, type StewardWebhookEventType, type StreamEventEnvelope, type UpdateStatus, type WalletTradingProfileResponse, type WalletTradingProfileSourceFilter, type WalletTradingProfileWindow, type WorkbenchOverview } from "../api";
import type { UiLanguage } from "../i18n";
import { type AutonomyRunHealthMap, mergeAutonomyEvents } from "./autonomy";
import type { LoadConversationMessagesResult } from "./internal";
export interface DataLoadersDeps {
    autonomousStoreRef: RefObject<ReturnType<typeof mergeAutonomyEvents>["store"]>;
    autonomousEventsRef: RefObject<StreamEventEnvelope[]>;
    autonomousLatestEventIdRef: RefObject<string | null>;
    autonomousRunHealthByRunIdRef: RefObject<AutonomyRunHealthMap>;
    autonomousReplayInFlightRef: RefObject<boolean>;
    setAutonomousEvents: (v: StreamEventEnvelope[]) => void;
    setAutonomousLatestEventId: (v: string | null) => void;
    setAutonomousRunHealthByRunId: (v: AutonomyRunHealthMap) => void;
    activeConversationIdRef: RefObject<string | null>;
    conversationMessagesRef: RefObject<ConversationMessage[]>;
    greetingFiredRef: RefObject<boolean>;
    setConversations: (v: Conversation[]) => void;
    setActiveConversationId: (v: string | null) => void;
    setConversationMessages: (v: ConversationMessage[]) => void;
    loadWalletConfig: () => Promise<void>;
    agentStatus: AgentStatus | null;
    characterData: CharacterData | null;
    characterDraft: CharacterData | null;
    loadCharacter: () => Promise<void>;
    selectedVrmIndex: number;
    onboardingComplete: boolean;
    uiLanguage: UiLanguage;
    setOwnerNameState: (v: string | null) => void;
}
export declare function useDataLoaders(deps: DataLoadersDeps): {
    applyAutonomyEventMerge: (incomingEvents: StreamEventEnvelope[], replay?: boolean) => import("./autonomy").MergeAutonomyEventsResult;
    fetchAutonomyReplay: () => Promise<void>;
    appendAutonomousEvent: (event: StreamEventEnvelope) => void;
    loadConversations: () => Promise<Conversation[] | null>;
    loadConversationMessages: (convId: string) => Promise<LoadConversationMessagesResult>;
    getBscTradePreflight: (tokenAddress?: string) => Promise<BscTradePreflightResponse>;
    getBscTradeQuote: (request: BscTradeQuoteRequest) => Promise<BscTradeQuoteResponse>;
    getBscTradeTxStatus: (hash: string) => Promise<BscTradeTxStatusResponse>;
    getStewardStatus: () => Promise<import("..").StewardStatusResponse>;
    getStewardAddresses: () => Promise<import("@elizaos/contracts").StewardWalletAddressesResponse>;
    getStewardBalance: (chainId?: number) => Promise<import("@elizaos/contracts").StewardBalanceResponse>;
    getStewardTokens: (chainId?: number) => Promise<import("@elizaos/contracts").StewardTokenBalancesResponse>;
    getStewardWebhookEvents: (opts?: {
        event?: StewardWebhookEventType;
        since?: number;
    }) => Promise<import("@elizaos/contracts").StewardWebhookEventsResponse>;
    getStewardHistory: (opts?: {
        status?: string;
        limit?: number;
        offset?: number;
    }) => Promise<{
        records: import("..").StewardHistoryResponse;
        total: number;
        offset: number;
        limit: number;
    }>;
    getStewardPending: () => Promise<import("..").StewardPendingResponse>;
    approveStewardTx: (txId: string) => Promise<import("..").StewardApprovalActionResponse>;
    rejectStewardTx: (txId: string, reason?: string) => Promise<import("..").StewardApprovalActionResponse>;
    loadWalletTradingProfile: (window?: WalletTradingProfileWindow, source?: WalletTradingProfileSourceFilter) => Promise<WalletTradingProfileResponse>;
    executeBscTrade: (request: BscTradeExecuteRequest) => Promise<BscTradeExecuteResponse>;
    executeBscTransfer: (request: BscTransferExecuteRequest) => Promise<BscTransferExecuteResponse>;
    loadInventory: () => Promise<void>;
    workbenchLoading: boolean;
    workbench: WorkbenchOverview | null;
    workbenchTasksAvailable: boolean;
    workbenchTriggersAvailable: boolean;
    workbenchTodosAvailable: boolean;
    loadWorkbench: () => Promise<void>;
    updateStatus: UpdateStatus | null;
    updateLoading: boolean;
    updateChannelSaving: boolean;
    loadUpdateStatus: (force?: boolean) => Promise<void>;
    handleChannelChange: (channel: "stable" | "beta" | "nightly") => Promise<void>;
    extensionStatus: ExtensionStatus | null;
    extensionChecking: boolean;
    checkExtensionStatus: () => Promise<void>;
};
//# sourceMappingURL=useDataLoaders.d.ts.map