/**
 * API client for the backend.
 *
 * Thin fetch wrapper + WebSocket for real-time chat/events.
 * Replaces the gateway WebSocket protocol entirely.
 *
 * The ElizaClient class is defined in client-base.ts and re-exported here.
 * Domain methods are defined via declaration merging + prototype augmentation
 * in the companion files: client-agent, client-chat, client-wallet,
 * client-cloud, client-skills, client-computeruse, client-imessage.
 */
import { DEFAULT_WALLET_RPC_SELECTIONS } from "@elizaos/core/contracts/wallet";
import { ElizaClient as _ElizaClient } from "./client-base";
import { WALLET_RPC_PROVIDER_OPTIONS } from "@elizaos/core/contracts/wallet";
import { getBootConfig as getBootConfigForNativeUpdate } from "../config/boot-config-store";
import { normalizeWalletRpcProviderId } from "@elizaos/core/contracts/wallet";
import { normalizeWalletRpcSelections } from "@elizaos/core/contracts/wallet";
import { type AllPermissionsState } from "@elizaos/core/contracts/permissions";
import { type AudioGenConfig } from "@elizaos/core/contracts/config";
import { type AudioGenProvider } from "@elizaos/core/contracts/config";
import { type BrowserWorkspaceSnapshot } from "./browser-contracts";
import { type BrowserWorkspaceTab } from "./browser-contracts";
import { type BscTradeExecuteRequest } from "@elizaos/core/contracts/wallet-types";
import { type BscTradeExecuteResponse } from "@elizaos/core/contracts/wallet-types";
import { type BscTradePreflightResponse } from "@elizaos/core/contracts/wallet-types";
import { type BscTradeQuoteRequest } from "@elizaos/core/contracts/wallet-types";
import { type BscTradeQuoteResponse } from "@elizaos/core/contracts/wallet-types";
import { type BscTradeTxStatusResponse } from "@elizaos/core/contracts/wallet-types";
import { type BscTransferExecuteRequest } from "@elizaos/core/contracts/wallet-types";
import { type BscTransferExecuteResponse } from "@elizaos/core/contracts/wallet-types";
import { type CloudProviderOption } from "@elizaos/core/contracts/first-run-options";
import { type CustomActionDef } from "@elizaos/core/contracts/config";
import { type CustomActionHandler } from "@elizaos/core/contracts/config";
import { type DatabaseProviderType } from "@elizaos/core/contracts/config";
import { type DropStatus } from "@elizaos/core/contracts/drop";
import { type ElizaClient } from "./client-base";
import { type EvmChainBalance } from "@elizaos/core/contracts/wallet-types";
import { type EvmNft } from "@elizaos/core/contracts/wallet-types";
import { type EvmTokenBalance } from "@elizaos/core/contracts/wallet-types";
import { type FirstRunConnection } from "@elizaos/core/contracts/first-run-options";
import { type FirstRunConnectorConfig as ConnectorConfig } from "@elizaos/core/contracts/first-run-options";
import { type FirstRunOptions } from "@elizaos/core/contracts/first-run-options";
import { type ImageConfig } from "@elizaos/core/contracts/config";
import { type ImageProvider } from "@elizaos/core/contracts/config";
import { type InventoryProviderOption } from "@elizaos/core/contracts/first-run-options";
import { type MediaConfig } from "@elizaos/core/contracts/config";
import { type MediaMode } from "@elizaos/core/contracts/config";
import { type MessageExample } from "@elizaos/core/contracts/first-run-options";
import { type MessageExampleContent } from "@elizaos/core/contracts/first-run-options";
import { type MintResult } from "@elizaos/core/contracts/drop";
import { type ModelOption } from "@elizaos/core/contracts/first-run-options";
import { type OpenRouterModelOption } from "@elizaos/core/contracts/first-run-options";
import { type PermissionId } from "@elizaos/core/contracts/permissions";
import { type PermissionState } from "@elizaos/core/contracts/permissions";
import { type PermissionStatus } from "@elizaos/core/contracts/permissions";
import { type ProviderOption } from "@elizaos/core/contracts/first-run-options";
import { type ReleaseChannel } from "@elizaos/core/contracts/config";
import { type RpcProviderOption } from "@elizaos/core/contracts/first-run-options";
import { type SolanaNft } from "@elizaos/core/contracts/wallet-types";
import { type SolanaTokenBalance } from "@elizaos/core/contracts/wallet-types";
import { type StewardApprovalActionResponse } from "./client-types-steward";
import { type StewardApprovalInfo } from "./client-types-steward";
import { type StewardBalanceResponse } from "./client-types-steward";
import { type StewardHistoryResponse } from "./client-types-steward";
import { type StewardPendingApproval } from "./client-types-steward";
import { type StewardPendingResponse } from "./client-types-steward";
import { type StewardPolicyResult } from "./client-types-steward";
import { type StewardSignRequest } from "./client-types-steward";
import { type StewardSignResponse } from "./client-types-steward";
import { type StewardStatusResponse } from "./client-types-steward";
import { type StewardTokenBalancesResponse } from "./client-types-steward";
import { type StewardTxRecord } from "./client-types-steward";
import { type StewardTxStatus } from "./client-types-steward";
import { type StewardWalletAddressesResponse } from "./client-types-steward";
import { type StewardWebhookEvent } from "./client-types-steward";
import { type StewardWebhookEventType } from "./client-types-steward";
import { type StewardWebhookEventsResponse } from "./client-types-steward";
import { type StylePreset } from "@elizaos/core/contracts/first-run-options";
import { type SubscriptionProviderStatus } from "@elizaos/core/contracts/first-run-options";
import { type SubscriptionStatusResponse } from "@elizaos/core/contracts/first-run-options";
import { type SystemPermissionDefinition } from "@elizaos/core/contracts/permissions";
import { type SystemPermissionId } from "@elizaos/core/contracts/permissions";
import { type VerificationResult } from "@elizaos/core/contracts/verification";
import { type VideoConfig } from "@elizaos/core/contracts/config";
import { type VideoProvider } from "@elizaos/core/contracts/config";
import { type VisionConfig } from "@elizaos/core/contracts/config";
import { type VisionProvider } from "@elizaos/core/contracts/config";
import { type WalletAddresses } from "@elizaos/core/contracts/wallet-types";
import { type WalletBalancesResponse } from "@elizaos/core/contracts/wallet-types";
import { type WalletConfigStatus } from "@elizaos/core/contracts/wallet-types";
import { type WalletConfigUpdateRequest } from "@elizaos/core/contracts/wallet-types";
import { type WalletNftsResponse } from "@elizaos/core/contracts/wallet-types";
import { type WalletRpcChain } from "@elizaos/core/contracts/wallet-types";
import { type WalletRpcCredentialKey } from "@elizaos/core/contracts/wallet-types";
import { type WalletRpcSelections } from "@elizaos/core/contracts/wallet-types";
import { type WalletTradingProfileResponse } from "@elizaos/core/contracts/wallet-types";
import { type WalletTradingProfileSourceFilter } from "@elizaos/core/contracts/wallet-types";
import { type WalletTradingProfileWindow } from "@elizaos/core/contracts/wallet-types";
export type { NativeAgentRequestOptions, NativeAgentRequestResult, } from "./android-native-agent-transport";
// Re-export the class from client-base (no circular dependency issues)
export { ElizaClient } from "./client-base";
export { CloudAgentWakeError, type CloudAgentWakePhase, waitForCloudAgentRunning, waitForCloudProvisionJob, } from "./client-cloud";
export type { ComputerUseApprovalMode, ComputerUseApprovalResolution, ComputerUseApprovalSnapshot, ComputerUsePendingApproval, } from "./client-computeruse";
export type { StoredFile } from "./client-files";
export type { GetIMessageMessagesOptions, IMessageApiChat, IMessageApiMessage, IMessageApiStatus, SendIMessageRequest, SendIMessageResponse, } from "./client-imessage";
export type { ActiveModelState, CatalogModel, DownloadJob, HardwareProbe, InstalledModel, ModelHubSnapshot, } from "./client-local-inference";
export type { ListMeetingsOptions } from "./client-meetings";
export { parseMeetingStatusEvent, parseMeetingTranscriptEvent, } from "./client-meetings";
export * from "./client-types";
export type { AgentRequestTransport } from "./transport";
export type { AllPermissionsState, AudioGenConfig, AudioGenProvider, BrowserWorkspaceSnapshot, BrowserWorkspaceTab, BscTradeExecuteRequest, BscTradeExecuteResponse, BscTradePreflightResponse, BscTradeQuoteRequest, BscTradeQuoteResponse, BscTradeTxStatusResponse, BscTransferExecuteRequest, BscTransferExecuteResponse, CloudProviderOption, ConnectorConfig, CustomActionDef, CustomActionHandler, DatabaseProviderType, DropStatus, EvmChainBalance, EvmNft, EvmTokenBalance, FirstRunConnection, FirstRunOptions, ImageConfig, ImageProvider, InventoryProviderOption, MediaConfig, MediaMode, MessageExample, MessageExampleContent, MintResult, ModelOption, OpenRouterModelOption, PermissionId, PermissionState, PermissionStatus, ProviderOption, ReleaseChannel, RpcProviderOption, SolanaNft, SolanaTokenBalance, StewardApprovalActionResponse, StewardApprovalInfo, StewardBalanceResponse, StewardHistoryResponse, StewardPendingApproval, StewardPendingResponse, StewardPolicyResult, StewardSignRequest, StewardSignResponse, StewardStatusResponse, StewardTokenBalancesResponse, StewardTxRecord, StewardTxStatus, StewardWalletAddressesResponse, StewardWebhookEvent, StewardWebhookEventsResponse, StewardWebhookEventType, StylePreset, SubscriptionProviderStatus, SubscriptionStatusResponse, SystemPermissionDefinition as PermissionDefinition, SystemPermissionId, VerificationResult, VideoConfig, VideoProvider, VisionConfig, VisionProvider, WalletAddresses, WalletBalancesResponse, WalletConfigStatus, WalletConfigUpdateRequest, WalletNftsResponse, WalletRpcChain, WalletRpcCredentialKey, WalletRpcSelections, WalletTradingProfileResponse, WalletTradingProfileSourceFilter, WalletTradingProfileWindow, };
export { DEFAULT_WALLET_RPC_SELECTIONS, normalizeWalletRpcProviderId, normalizeWalletRpcSelections, WALLET_RPC_PROVIDER_OPTIONS, };
// ---------------------------------------------------------------------------
// Domain method augmentations (declaration merging + prototype assignment)
// These import ElizaClient from client-base directly, avoiding circular deps.
// ---------------------------------------------------------------------------
import "./client-agent";
import "./client-accounts";
import "./client-approvals";
import "./client-automations";
import "./client-background";
import "./client-browser-workspace";
import "./client-chat";
import "./client-cloud";
import "./client-computeruse";
import "./client-files";
import "./client-imessage";
import "./client-local-inference";
import "./client-meetings";
import "./client-notifications";
import "./client-scheduled-tasks";
import "./client-voice-models";
import "./client-workflow";
import "./client-skills";
import "./client-transcripts";
import "./client-vault";
import "./client-wallet";
// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------
// External plugins augment ElizaClient via `declare module "@elizaos/ui"`.
// Annotating with ElizaClient (which TypeScript normalizes to the canonical
// @elizaos/ui export) makes augmented methods visible to callers. The
// prototype has all methods at runtime via the augmenting side-effect imports.
export const client: ElizaClient = new _ElizaClient();
if (typeof window !== "undefined") {
    window.addEventListener("eliza:desktop-api-base-updated", (event: Event) => {
        const detail = (event as CustomEvent<{
            previousBase: string | null;
            base: string;
        }>).detail;
        if (!detail || typeof detail.base !== "string")
            return;
        const current = client.getBaseUrl().replace(/\/+$/, "");
        if (current !== detail.previousBase &&
            current !== detail.base &&
            current !== "")
            return;
        const config = getBootConfigForNativeUpdate();
        const nativeWindow = window as typeof window & {
            __ELIZA_DESKTOP_LOCAL_API_BASE__?: string;
            __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: string;
        };
        const binding = nativeWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__ ??
            nativeWindow.__ELIZA_DESKTOP_EXTERNAL_API_BASE__;
        if (binding !== detail.base || config.apiBase !== detail.base)
            return;
        const token = config.apiToken?.trim() || null;
        // Native publication already excludes unchanged base/token pairs. Lazy
        // getters can show the new config while the old WebSocket is still open.
        client.repointBaseUrl(detail.base, token);
    });
}
