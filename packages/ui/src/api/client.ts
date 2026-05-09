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

import type {
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
} from "@elizaos/plugin-browser/workspace";
import type {
  AllPermissionsState,
  AudioGenConfig,
  AudioGenProvider,
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  CloudProviderOption,
  OnboardingConnectorConfig as ConnectorConfig,
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  DropStatus,
  EvmChainBalance,
  EvmNft,
  EvmTokenBalance,
  ImageConfig,
  ImageProvider,
  InventoryProviderOption,
  MediaConfig,
  MediaMode,
  MessageExample,
  MessageExampleContent,
  MintResult,
  ModelOption,
  OnboardingConnection,
  OnboardingOptions,
  OpenRouterModelOption,
  PermissionState,
  PermissionStatus,
  ProviderOption,
  ReleaseChannel,
  RpcProviderOption,
  SolanaNft,
  SolanaTokenBalance,
  StylePreset,
  SubscriptionProviderStatus,
  SubscriptionStatusResponse,
  SystemPermissionDefinition,
  SystemPermissionId,
  VerificationResult,
  VideoConfig,
  VideoProvider,
  VisionConfig,
  VisionProvider,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletNftsResponse,
  WalletRpcChain,
  WalletRpcCredentialKey,
  WalletRpcSelections,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
} from "@elizaos/shared";
import {
  DEFAULT_WALLET_RPC_SELECTIONS,
  normalizeWalletRpcProviderId,
  normalizeWalletRpcSelections,
  WALLET_RPC_PROVIDER_OPTIONS,
} from "@elizaos/shared";
import type {
  StewardApprovalActionResponse,
  StewardApprovalInfo,
  StewardBalanceResponse,
  StewardHistoryResponse,
  StewardPendingApproval,
  StewardPendingResponse,
  StewardPolicyResult,
  StewardSignRequest,
  StewardSignResponse,
  StewardStatusResponse,
  StewardTokenBalancesResponse,
  StewardTxRecord,
  StewardTxStatus,
  StewardWalletAddressesResponse,
  StewardWebhookEvent,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
} from "./client-types-steward";

export type {
  NativeAgentRequestOptions,
  NativeAgentRequestResult,
} from "./android-native-agent-transport";
// Re-export the class from client-base (no circular dependency issues)
export { ElizaClient } from "./client-base";
export type {
  ComputerUseApprovalMode,
  ComputerUseApprovalResolution,
  ComputerUseApprovalSnapshot,
  ComputerUsePendingApproval,
} from "./client-computeruse";
export type {
  GetIMessageMessagesOptions,
  IMessageApiChat,
  IMessageApiMessage,
  IMessageApiStatus,
  SendIMessageRequest,
  SendIMessageResponse,
} from "./client-imessage";
export type {
  ActiveModelState,
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelHubSnapshot,
} from "./client-local-inference";
export * from "./client-types";
export type { AgentRequestTransport } from "./transport";
export type {
  AllPermissionsState,
  AudioGenConfig,
  AudioGenProvider,
  BrowserWorkspaceSnapshot,
  BrowserWorkspaceTab,
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  CloudProviderOption,
  ConnectorConfig,
  CustomActionDef,
  CustomActionHandler,
  DatabaseProviderType,
  DropStatus,
  EvmChainBalance,
  EvmNft,
  EvmTokenBalance,
  ImageConfig,
  ImageProvider,
  InventoryProviderOption,
  MediaConfig,
  MediaMode,
  MessageExample,
  MessageExampleContent,
  MintResult,
  ModelOption,
  OnboardingConnection,
  OnboardingOptions,
  OpenRouterModelOption,
  PermissionState,
  PermissionStatus,
  ProviderOption,
  ReleaseChannel,
  RpcProviderOption,
  SolanaNft,
  SolanaTokenBalance,
  StewardApprovalActionResponse,
  StewardApprovalInfo,
  StewardBalanceResponse,
  StewardHistoryResponse,
  StewardPendingApproval,
  StewardPendingResponse,
  StewardPolicyResult,
  StewardSignRequest,
  StewardSignResponse,
  StewardStatusResponse,
  StewardTokenBalancesResponse,
  StewardTxRecord,
  StewardTxStatus,
  StewardWalletAddressesResponse,
  StewardWebhookEvent,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
  StylePreset,
  SubscriptionProviderStatus,
  SubscriptionStatusResponse,
  SystemPermissionDefinition as PermissionDefinition,
  SystemPermissionId,
  VerificationResult,
  VideoConfig,
  VideoProvider,
  VisionConfig,
  VisionProvider,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletNftsResponse,
  WalletRpcChain,
  WalletRpcCredentialKey,
  WalletRpcSelections,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
};
export {
  DEFAULT_WALLET_RPC_SELECTIONS,
  normalizeWalletRpcProviderId,
  normalizeWalletRpcSelections,
  WALLET_RPC_PROVIDER_OPTIONS,
};
// ---------------------------------------------------------------------------
// Domain method augmentations (declaration merging + prototype assignment)
// These import ElizaClient from client-base directly, avoiding circular deps.
// ---------------------------------------------------------------------------

import "./client-agent";
import "./client-automations";
import "./client-browser-workspace";
import "./client-chat";
import "./client-cloud";
import "./client-computeruse";
import "./client-imessage";
import "./client-local-inference";
import "./client-workflow";
import "./client-skills";
import "./client-vault";
import "./client-wallet";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

import { ElizaClient as _ElizaClient } from "./client-base";
export const client = new _ElizaClient();
