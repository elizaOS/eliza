/**
 * Wallet API contracts.
 *
 * Type contracts moved to @elizaos/contracts (Phase 5A). Re-export here
 * so existing consumers that import from this module keep compiling.
 * Runtime helpers (normalizers, constants) remain here.
 */

import type {
	BscTradeExecuteRequest,
	BscTradeExecuteResponse,
	BscTradeExecutionResult,
	BscTradePreflightRequest,
	BscTradePreflightResponse,
	BscTradeQuoteLeg,
	BscTradeQuoteRequest,
	BscTradeQuoteResponse,
	BscTradeReadinessChecks,
	BscTradeRoutePreference,
	BscTradeRouteProvider,
	BscTradeSide,
	BscTradeTxStatus,
	BscTradeTxStatusResponse,
	BscTransferExecuteRequest,
	BscTransferExecuteResponse,
	BscTransferExecutionResult,
	BscUnsignedApprovalTx,
	BscUnsignedTradeTx,
	BscUnsignedTransferTx,
	BscWalletRpcProvider,
	EvmChainBalance,
	EvmNft,
	EvmSigningCapabilityKind,
	EvmTokenBalance,
	EvmWalletRpcProvider,
	KeyValidationResult,
	SolanaNft,
	SolanaTokenBalance,
	SolanaWalletRpcProvider,
	StewardApprovalInfo,
	StewardBalanceResponse,
	StewardPolicyResult,
	StewardTokenBalance,
	StewardTokenBalancesResponse,
	StewardWalletAddressesResponse,
	StewardWebhookEvent,
	StewardWebhookEventsResponse,
	StewardWebhookEventType,
	TradePermissionMode,
	WalletAddresses,
	WalletAddressPair,
	WalletBalancesResponse,
	WalletChain,
	WalletChainKind,
	WalletConfigStatus,
	WalletConfigUpdateRequest,
	WalletEntry,
	WalletEvmBalances,
	WalletEvmNftCollection,
	WalletExportRejection,
	WalletExportRequestBody,
	WalletGenerateResult,
	WalletImportResult,
	WalletKeys,
	WalletMarketMover,
	WalletMarketOverviewProviderId,
	WalletMarketOverviewResponse,
	WalletMarketOverviewSource,
	WalletMarketPrediction,
	WalletMarketPriceSnapshot,
	WalletNetworkMode,
	WalletNftMetadataBase,
	WalletNftsResponse,
	WalletPrimaryMap,
	WalletPrimaryUpdateRequest,
	WalletPrimaryUpdateResponse,
	WalletProviderKind,
	WalletRpcChain,
	WalletRpcCredentialKey,
	WalletRpcSelections,
	WalletSolanaBalances,
	WalletSolanaNftCollection,
	WalletSource,
	WalletTokenBalanceBase,
	WalletTradeLedgerEntry,
	WalletTradeLedgerQuoteLeg,
	WalletTradeLedgerRecordInput,
	WalletTradeSource,
	WalletTradingProfileRecentSwap,
	WalletTradingProfileResponse,
	WalletTradingProfileSeriesPoint,
	WalletTradingProfileSourceFilter,
	WalletTradingProfileSummary,
	WalletTradingProfileTokenBreakdown,
	WalletTradingProfileWindow,
} from "@elizaos/contracts";

export type {
	BscTradeExecuteRequest,
	BscTradeExecuteResponse,
	BscTradeExecutionResult,
	BscTradePreflightRequest,
	BscTradePreflightResponse,
	BscTradeQuoteLeg,
	BscTradeQuoteRequest,
	BscTradeQuoteResponse,
	BscTradeReadinessChecks,
	BscTradeRoutePreference,
	BscTradeRouteProvider,
	BscTradeSide,
	BscTradeTxStatus,
	BscTradeTxStatusResponse,
	BscTransferExecuteRequest,
	BscTransferExecuteResponse,
	BscTransferExecutionResult,
	BscUnsignedApprovalTx,
	BscUnsignedTradeTx,
	BscUnsignedTransferTx,
	BscWalletRpcProvider,
	EvmChainBalance,
	EvmNft,
	EvmSigningCapabilityKind,
	EvmTokenBalance,
	EvmWalletRpcProvider,
	KeyValidationResult,
	SolanaNft,
	SolanaTokenBalance,
	SolanaWalletRpcProvider,
	StewardApprovalInfo,
	StewardBalanceResponse,
	StewardPolicyResult,
	StewardTokenBalance,
	StewardTokenBalancesResponse,
	StewardWalletAddressesResponse,
	StewardWebhookEvent,
	StewardWebhookEventsResponse,
	StewardWebhookEventType,
	TradePermissionMode,
	WalletAddresses,
	WalletAddressPair,
	WalletBalancesResponse,
	WalletChain,
	WalletChainKind,
	WalletConfigStatus,
	WalletConfigUpdateRequest,
	WalletEntry,
	WalletEvmBalances,
	WalletEvmNftCollection,
	WalletExportRejection,
	WalletExportRequestBody,
	WalletGenerateResult,
	WalletImportResult,
	WalletKeys,
	WalletMarketMover,
	WalletMarketOverviewProviderId,
	WalletMarketOverviewResponse,
	WalletMarketOverviewSource,
	WalletMarketPrediction,
	WalletMarketPriceSnapshot,
	WalletNetworkMode,
	WalletNftMetadataBase,
	WalletNftsResponse,
	WalletPrimaryMap,
	WalletPrimaryUpdateRequest,
	WalletPrimaryUpdateResponse,
	WalletProviderKind,
	WalletRpcChain,
	WalletRpcCredentialKey,
	WalletRpcSelections,
	WalletSolanaBalances,
	WalletSolanaNftCollection,
	WalletSource,
	WalletTokenBalanceBase,
	WalletTradeLedgerEntry,
	WalletTradeLedgerQuoteLeg,
	WalletTradeLedgerRecordInput,
	WalletTradeSource,
	WalletTradingProfileRecentSwap,
	WalletTradingProfileResponse,
	WalletTradingProfileSeriesPoint,
	WalletTradingProfileSourceFilter,
	WalletTradingProfileSummary,
	WalletTradingProfileTokenBreakdown,
	WalletTradingProfileWindow,
};

// ---------------------------------------------------------------------------
// Runtime helpers — constants and normalizers not in @elizaos/contracts.
// ---------------------------------------------------------------------------

export const WALLET_RPC_PROVIDER_OPTIONS = {
	evm: [
		{ id: "eliza-cloud" as EvmWalletRpcProvider, label: "Eliza Cloud" },
		{ id: "alchemy" as EvmWalletRpcProvider, label: "Alchemy" },
		{ id: "infura" as EvmWalletRpcProvider, label: "Infura" },
		{ id: "ankr" as EvmWalletRpcProvider, label: "Ankr" },
	],
	bsc: [
		{ id: "eliza-cloud" as BscWalletRpcProvider, label: "Eliza Cloud" },
		{ id: "alchemy" as BscWalletRpcProvider, label: "Alchemy" },
		{ id: "ankr" as BscWalletRpcProvider, label: "Ankr" },
		{ id: "nodereal" as BscWalletRpcProvider, label: "NodeReal" },
		{ id: "quicknode" as BscWalletRpcProvider, label: "QuickNode" },
	],
	solana: [
		{ id: "eliza-cloud" as SolanaWalletRpcProvider, label: "Eliza Cloud" },
		{
			id: "helius-birdeye" as SolanaWalletRpcProvider,
			label: "Helius + Birdeye",
		},
	],
} as const;

export const DEFAULT_WALLET_RPC_SELECTIONS: WalletRpcSelections = {
	evm: "eliza-cloud",
	bsc: "eliza-cloud",
	solana: "eliza-cloud",
};

const WALLET_RPC_PROVIDER_ALIASES = {
	elizacloud: "eliza-cloud",
	helius: "helius-birdeye",
} as const;

const WALLET_RPC_PROVIDER_IDS: Record<WalletRpcChain, ReadonlySet<string>> = {
	evm: new Set<EvmWalletRpcProvider>([
		"eliza-cloud",
		"alchemy",
		"infura",
		"ankr",
	]),
	bsc: new Set<BscWalletRpcProvider>([
		"eliza-cloud",
		"alchemy",
		"ankr",
		"nodereal",
		"quicknode",
	]),
	solana: new Set<SolanaWalletRpcProvider>(["eliza-cloud", "helius-birdeye"]),
};

export function normalizeWalletRpcProviderId<TChain extends WalletRpcChain>(
	chain: TChain,
	value: string | null | undefined,
): WalletRpcSelections[TChain] | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	const normalized = WALLET_RPC_PROVIDER_ALIASES[
		trimmed as keyof typeof WALLET_RPC_PROVIDER_ALIASES
	]
		? WALLET_RPC_PROVIDER_ALIASES[
				trimmed as keyof typeof WALLET_RPC_PROVIDER_ALIASES
			]
		: trimmed;
	if (WALLET_RPC_PROVIDER_IDS[chain].has(normalized)) {
		return normalized as WalletRpcSelections[TChain];
	}
	return null;
}

export function normalizeWalletRpcSelections(
	input:
		| Partial<Record<WalletRpcChain, string | null | undefined>>
		| WalletRpcSelections
		| null
		| undefined,
): WalletRpcSelections {
	return {
		evm:
			normalizeWalletRpcProviderId("evm", input?.evm) ??
			DEFAULT_WALLET_RPC_SELECTIONS.evm,
		bsc:
			normalizeWalletRpcProviderId("bsc", input?.bsc) ??
			DEFAULT_WALLET_RPC_SELECTIONS.bsc,
		solana:
			normalizeWalletRpcProviderId("solana", input?.solana) ??
			DEFAULT_WALLET_RPC_SELECTIONS.solana,
	};
}
