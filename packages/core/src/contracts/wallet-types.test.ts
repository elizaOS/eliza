/**
 * Compile-time and deterministic fixture tests for the wallet API contracts.
 * The suite covers every literal branch and representative nested shapes
 * without mocking a runtime implementation for this type-only module.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import type * as Wallet from "./wallet-types.js";

const rpcChains = [
	"evm",
	"bsc",
	"solana",
] as const satisfies readonly Wallet.WalletRpcChain[];
const evmRpcProviders = [
	"eliza-cloud",
	"alchemy",
	"infura",
	"ankr",
] as const satisfies readonly Wallet.EvmWalletRpcProvider[];
const bscRpcProviders = [
	"eliza-cloud",
	"alchemy",
	"ankr",
	"nodereal",
	"quicknode",
] as const satisfies readonly Wallet.BscWalletRpcProvider[];
const solanaRpcProviders = [
	"eliza-cloud",
	"helius-birdeye",
] as const satisfies readonly Wallet.SolanaWalletRpcProvider[];
const rpcCredentialKeys = [
	"ALCHEMY_API_KEY",
	"INFURA_API_KEY",
	"ANKR_API_KEY",
	"NODEREAL_BSC_RPC_URL",
	"QUICKNODE_BSC_RPC_URL",
	"HELIUS_API_KEY",
	"BIRDEYE_API_KEY",
	"ETHEREUM_RPC_URL",
	"BASE_RPC_URL",
	"AVALANCHE_RPC_URL",
	"BSC_RPC_URL",
	"SOLANA_RPC_URL",
] as const satisfies readonly Wallet.WalletRpcCredentialKey[];

const signingCapabilities = [
	"local",
	"steward-self",
	"steward-cloud",
	"cloud-view-only",
	"none",
] as const satisfies readonly Wallet.EvmSigningCapabilityKind[];
const tradePermissions = [
	"user-sign-only",
	"manual-local-key",
	"agent-auto",
	"disabled",
] as const satisfies readonly Wallet.TradePermissionMode[];
const tradeStatuses = [
	"pending",
	"success",
	"reverted",
	"not_found",
] as const satisfies readonly Wallet.BscTradeTxStatus[];
const webhookEvents = [
	"tx.pending",
	"tx.approved",
	"tx.denied",
	"tx.confirmed",
] as const satisfies readonly Wallet.StewardWebhookEventType[];

const tokenBase = {
	symbol: "USDC",
	name: "USD Coin",
	balance: "2500000",
	decimals: 6,
	valueUsd: "2.50",
	logoUrl: "https://example.test/usdc.png",
} satisfies Wallet.WalletTokenBalanceBase;

const preflight = {
	ok: true,
	walletAddress: "0xabc",
	rpcUrlHost: "rpc.example.test",
	chainId: 56,
	bnbBalance: "1.25",
	minGasBnb: "0.005",
	checks: {
		walletReady: true,
		rpcReady: true,
		chainReady: true,
		gasReady: true,
		tokenAddressValid: true,
	},
	reasons: [],
} satisfies Wallet.BscTradePreflightResponse;

const quoteLeg = {
	symbol: "BNB",
	amount: "1",
	amountWei: "1000000000000000000",
} satisfies Wallet.BscTradeQuoteLeg;

const quote = {
	ok: true,
	side: "buy",
	routeProvider: "pancakeswap-v2",
	routeProviderRequested: "auto",
	routeProviderFallbackUsed: false,
	routerAddress: "0xrouter",
	wrappedNativeAddress: "0xwrapped",
	tokenAddress: "0xtoken",
	slippageBps: 50,
	route: ["WBNB", "TOKEN"],
	quoteIn: quoteLeg,
	quoteOut: { ...quoteLeg, symbol: "TOKEN", amount: "100" },
	minReceive: { ...quoteLeg, symbol: "TOKEN", amount: "99.5" },
	price: "100",
	preflight,
} satisfies Wallet.BscTradeQuoteResponse;

const unsignedTrade = {
	chainId: 56,
	from: "0xabc",
	to: "0xrouter",
	data: "0xdeadbeef",
	valueWei: quoteLeg.amountWei,
	deadline: 1_800_000_000,
	explorerUrl: "https://bscscan.com/tx/0xhash",
} satisfies Wallet.BscUnsignedTradeTx;

describe("wallet type contracts", () => {
	it("keeps every provider, credential, and network literal exhaustive", () => {
		expect(rpcChains).toEqual(["evm", "bsc", "solana"]);
		expect(evmRpcProviders).toEqual([
			"eliza-cloud",
			"alchemy",
			"infura",
			"ankr",
		]);
		expect(bscRpcProviders).toEqual([
			"eliza-cloud",
			"alchemy",
			"ankr",
			"nodereal",
			"quicknode",
		]);
		expect(solanaRpcProviders).toEqual(["eliza-cloud", "helius-birdeye"]);
		expect(rpcCredentialKeys).toHaveLength(12);

		expectTypeOf<
			Exclude<Wallet.WalletRpcChain, (typeof rpcChains)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			Exclude<Wallet.EvmWalletRpcProvider, (typeof evmRpcProviders)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			Exclude<Wallet.BscWalletRpcProvider, (typeof bscRpcProviders)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			Exclude<
				Wallet.SolanaWalletRpcProvider,
				(typeof solanaRpcProviders)[number]
			>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			Exclude<Wallet.WalletRpcCredentialKey, (typeof rpcCredentialKeys)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<Wallet.WalletNetworkMode>().toEqualTypeOf<
			"mainnet" | "testnet"
		>();

		const selections = {
			evm: "infura",
			bsc: "nodereal",
			solana: "helius-birdeye",
		} satisfies Wallet.WalletRpcSelections;
		const update = {
			selections,
			walletNetwork: "testnet",
			credentials: { INFURA_API_KEY: "secret" },
		} satisfies Wallet.WalletConfigUpdateRequest;
		expect(update).toEqual({
			selections,
			walletNetwork: "testnet",
			credentials: { INFURA_API_KEY: "secret" },
		});
	});

	it("preserves wallet keys, nullable addresses, balances, and NFT shapes", () => {
		const keys = {
			evmPrivateKey: "0xprivate",
			evmAddress: "0xabc",
			solanaPrivateKey: "sol-private",
			solanaAddress: "sol-address",
		} satisfies Wallet.WalletKeys;
		const addresses = {
			evmAddress: keys.evmAddress,
			solanaAddress: null,
		} satisfies Wallet.WalletAddresses;
		const evmToken = {
			...tokenBase,
			contractAddress: "0xtoken",
		} satisfies Wallet.EvmTokenBalance;
		const solanaToken = {
			...tokenBase,
			mint: "mint-address",
		} satisfies Wallet.SolanaTokenBalance;
		const chain = {
			chain: "bsc",
			chainId: 56,
			nativeBalance: "1.25",
			nativeSymbol: "BNB",
			nativeValueUsd: "750",
			tokens: [evmToken],
			error: null,
		} satisfies Wallet.EvmChainBalance;
		const balances = {
			evm: { address: keys.evmAddress, chains: [chain] },
			solana: {
				address: "sol-address",
				solBalance: "3",
				solValueUsd: "450",
				tokens: [solanaToken],
			},
		} satisfies Wallet.WalletBalancesResponse;

		const nftBase = {
			name: "Wallet NFT",
			description: "A deterministic fixture",
			imageUrl: "https://example.test/nft.png",
			collectionName: "Core",
		} satisfies Wallet.WalletNftMetadataBase;
		const evmNft = {
			...nftBase,
			contractAddress: "0xnft",
			tokenId: "7",
			tokenType: "ERC721",
		} satisfies Wallet.EvmNft;
		const solanaNft = {
			...nftBase,
			mint: "nft-mint",
		} satisfies Wallet.SolanaNft;
		const evmCollection = {
			chain: "ethereum",
			nfts: [evmNft],
		} satisfies Wallet.WalletEvmNftCollection;
		const solanaCollection = {
			nfts: [solanaNft],
		} satisfies Wallet.WalletSolanaNftCollection;
		const nfts = {
			evm: [evmCollection],
			solana: solanaCollection,
		} satisfies Wallet.WalletNftsResponse;

		expect(addresses.solanaAddress).toBeNull();
		expect(balances.evm?.chains[0]?.tokens).toEqual([evmToken]);
		expect(nfts.solana?.nfts[0]?.mint).toBe("nft-mint");
		expectTypeOf<Wallet.WalletAddressPair>().toEqualTypeOf<{
			evmAddress: string | null;
			solanaAddress: string | null;
		}>();
		expectTypeOf<Wallet.WalletEvmBalances>().toMatchTypeOf<{
			address: string;
			chains: Wallet.EvmChainBalance[];
		}>();
		expectTypeOf<Wallet.WalletSolanaBalances>().toMatchTypeOf<{
			address: string;
			tokens: Wallet.SolanaTokenBalance[];
		}>();
	});

	it("models configuration readiness and primary wallet choices", () => {
		const status = {
			evmAddress: "0xabc",
			solanaAddress: null,
			selectedRpcProviders: {
				evm: "eliza-cloud",
				bsc: "quicknode",
				solana: "eliza-cloud",
			},
			legacyCustomChains: ["evm"],
			alchemyKeySet: false,
			infuraKeySet: false,
			ankrKeySet: false,
			heliusKeySet: false,
			birdeyeKeySet: false,
			evmChains: ["ethereum", "base"],
			executionBlockedReason: null,
			evmSigningCapability: "cloud-view-only",
			wallets: [
				{
					source: "cloud",
					chain: "evm",
					address: "0xabc",
					provider: "privy",
					primary: true,
				},
			],
			primary: { evm: "cloud", solana: "local" },
		} satisfies Wallet.WalletConfigStatus;
		const primaryRequest = {
			chain: "evm",
			source: "cloud",
		} satisfies Wallet.WalletPrimaryUpdateRequest;
		const primaryResponse = {
			ok: true,
			...primaryRequest,
			warnings: [],
		} satisfies Wallet.WalletPrimaryUpdateResponse;

		expect(signingCapabilities).toHaveLength(5);
		expect(tradePermissions).toHaveLength(4);
		expect(status.wallets?.[0]?.primary).toBe(true);
		expect(primaryResponse.warnings).toEqual([]);
		expectTypeOf<
			Exclude<
				Wallet.EvmSigningCapabilityKind,
				(typeof signingCapabilities)[number]
			>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			Exclude<Wallet.TradePermissionMode, (typeof tradePermissions)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<Wallet.WalletSource>().toEqualTypeOf<"local" | "cloud">();
		expectTypeOf<Wallet.WalletChainKind>().toEqualTypeOf<"evm" | "solana">();
		expectTypeOf<Wallet.WalletProviderKind>().toEqualTypeOf<
			"local" | "privy" | "steward"
		>();
		expectTypeOf<Wallet.WalletEntry>()
			.toHaveProperty("primary")
			.toEqualTypeOf<boolean>();
		expectTypeOf<Wallet.WalletPrimaryMap>().toEqualTypeOf<{
			evm: Wallet.WalletSource;
			solana: Wallet.WalletSource;
		}>();
	});

	it("covers preflight, quote, execution, status, and transfer variants", () => {
		const preflightRequest = {
			tokenAddress: "0xtoken",
		} satisfies Wallet.BscTradePreflightRequest;
		const quoteRequest = {
			side: "buy",
			tokenAddress: "0xtoken",
			amount: "1",
			slippageBps: 50,
			routeProvider: "auto",
		} satisfies Wallet.BscTradeQuoteRequest;
		const executeRequest = {
			...quoteRequest,
			confirm: true,
			deadlineSeconds: 300,
		} satisfies Wallet.BscTradeExecuteRequest;
		const approvalTx = {
			chainId: 56,
			from: "0xabc",
			to: "0xtoken",
			data: "0xapprove",
			valueWei: "0",
			explorerUrl: "https://bscscan.com/tx/0xapproval",
			spender: "0xrouter",
			amountWei: quoteLeg.amountWei,
		} satisfies Wallet.BscUnsignedApprovalTx;
		const execution = {
			hash: "0xhash",
			nonce: 7,
			gasLimit: "21000",
			valueWei: quoteLeg.amountWei,
			explorerUrl: unsignedTrade.explorerUrl,
			blockNumber: null,
			status: "pending",
			approvalHash: "0xapproval",
		} satisfies Wallet.BscTradeExecutionResult;
		const executeResponse = {
			ok: true,
			side: "buy",
			mode: "steward",
			quote,
			executed: false,
			requiresUserSignature: false,
			unsignedTx: unsignedTrade,
			unsignedApprovalTx: approvalTx,
			requiresApproval: true,
			execution: { ...execution, status: "pending_approval" },
			approval: {
				status: "pending_approval",
				policyResults: [{ policyId: "policy-1", status: "pending" }],
			},
		} satisfies Wallet.BscTradeExecuteResponse;
		const statusResponse = {
			ok: true,
			hash: execution.hash,
			status: "not_found",
			explorerUrl: execution.explorerUrl,
			chainId: null,
			blockNumber: null,
			confirmations: 0,
			nonce: null,
			gasUsed: null,
			effectiveGasPriceWei: null,
			reason: "not indexed",
		} satisfies Wallet.BscTradeTxStatusResponse;
		const transferRequest = {
			toAddress: "0xrecipient",
			amount: "2",
			assetSymbol: "BNB",
			confirm: true,
		} satisfies Wallet.BscTransferExecuteRequest;
		const unsignedTransfer = {
			chainId: 56,
			from: null,
			to: transferRequest.toAddress,
			data: "0x",
			valueWei: "2000000000000000000",
			explorerUrl: "https://bscscan.com/tx/0xtransfer",
			assetSymbol: transferRequest.assetSymbol,
			amount: transferRequest.amount,
		} satisfies Wallet.BscUnsignedTransferTx;
		const transferExecution = {
			hash: "0xtransfer",
			nonce: 8,
			gasLimit: "21000",
			valueWei: unsignedTransfer.valueWei,
			explorerUrl: unsignedTransfer.explorerUrl,
			blockNumber: 42,
			status: "success",
		} satisfies Wallet.BscTransferExecutionResult;
		const transferResponse = {
			ok: true,
			mode: "local-key",
			executed: true,
			requiresUserSignature: false,
			toAddress: transferRequest.toAddress,
			amount: transferRequest.amount,
			assetSymbol: transferRequest.assetSymbol,
			unsignedTx: unsignedTransfer,
			execution: transferExecution,
		} satisfies Wallet.BscTransferExecuteResponse;

		expect(preflightRequest.tokenAddress).toBe("0xtoken");
		expect(executeRequest.deadlineSeconds).toBe(300);
		expect(executeResponse.approval?.status).toBe("pending_approval");
		expect(statusResponse.status).toBe("not_found");
		expect(transferResponse.execution?.status).toBe("success");
		expectTypeOf<Wallet.BscTradeSide>().toEqualTypeOf<"buy" | "sell">();
		expectTypeOf<Wallet.BscTradeRouteProvider>().toEqualTypeOf<
			"pancakeswap-v2" | "0x"
		>();
		expectTypeOf<Wallet.BscTradeRoutePreference>().toEqualTypeOf<
			Wallet.BscTradeRouteProvider | "auto"
		>();
		expectTypeOf<
			Exclude<Wallet.BscTradeTxStatus, (typeof tradeStatuses)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<Wallet.BscTradeReadinessChecks>().toEqualTypeOf<
			typeof preflight.checks
		>();
	});

	it("preserves ledger, profile, and market overview response shapes", () => {
		const ledgerLeg = {
			...quoteLeg,
		} satisfies Wallet.WalletTradeLedgerQuoteLeg;
		const ledgerInput = {
			hash: "0xhash",
			source: "agent",
			side: "sell",
			tokenAddress: "0xtoken",
			slippageBps: 75,
			route: ["TOKEN", "WBNB"],
			quoteIn: ledgerLeg,
			quoteOut: { ...ledgerLeg, symbol: "WBNB" },
			status: "success",
			confirmations: 5,
			nonce: 9,
			blockNumber: 43,
			gasUsed: "120000",
			effectiveGasPriceWei: "3000000000",
			explorerUrl: "https://bscscan.com/tx/0xhash",
		} satisfies Wallet.WalletTradeLedgerRecordInput;
		const ledgerEntry = {
			...ledgerInput,
			createdAt: "2026-08-23T00:00:00.000Z",
			updatedAt: "2026-08-23T00:01:00.000Z",
		} satisfies Wallet.WalletTradeLedgerEntry;
		const summary = {
			totalSwaps: 1,
			buyCount: 0,
			sellCount: 1,
			settledCount: 1,
			successCount: 1,
			revertedCount: 0,
			tradeWinRate: 1,
			txSuccessRate: 1,
			winningTrades: 1,
			evaluatedTrades: 1,
			realizedPnlBnb: "0.1",
			volumeBnb: "1",
		} satisfies Wallet.WalletTradingProfileSummary;
		const seriesPoint = {
			day: "2026-08-23",
			realizedPnlBnb: "0.1",
			volumeBnb: "1",
			swaps: 1,
		} satisfies Wallet.WalletTradingProfileSeriesPoint;
		const tokenBreakdown = {
			tokenAddress: ledgerEntry.tokenAddress,
			symbol: "TOKEN",
			buyCount: 0,
			sellCount: 1,
			realizedPnlBnb: "0.1",
			volumeBnb: "1",
			tradeWinRate: 1,
			winningTrades: 1,
			evaluatedTrades: 1,
		} satisfies Wallet.WalletTradingProfileTokenBreakdown;
		const recentSwap = {
			hash: ledgerEntry.hash,
			createdAt: ledgerEntry.createdAt,
			source: ledgerEntry.source,
			side: ledgerEntry.side,
			status: ledgerEntry.status,
			tokenAddress: ledgerEntry.tokenAddress,
			tokenSymbol: "TOKEN",
			inputAmount: "100",
			inputSymbol: "TOKEN",
			outputAmount: "1",
			outputSymbol: "BNB",
			explorerUrl: ledgerEntry.explorerUrl,
			confirmations: ledgerEntry.confirmations,
		} satisfies Wallet.WalletTradingProfileRecentSwap;
		const profile = {
			window: "24h",
			source: "all",
			generatedAt: ledgerEntry.updatedAt,
			summary,
			pnlSeries: [seriesPoint],
			tokenBreakdown: [tokenBreakdown],
			recentSwaps: [recentSwap],
		} satisfies Wallet.WalletTradingProfileResponse;

		const price = {
			id: "bnb",
			symbol: "BNB",
			name: "BNB",
			priceUsd: 600,
			change24hPct: 2.5,
			imageUrl: null,
		} satisfies Wallet.WalletMarketPriceSnapshot;
		const mover = {
			...price,
			marketCapRank: 4,
		} satisfies Wallet.WalletMarketMover;
		const prediction = {
			id: "market-1",
			slug: null,
			question: "Will the contract remain stable?",
			highlightedOutcomeLabel: "Yes",
			highlightedOutcomeProbability: 0.9,
			volume24hUsd: 1_000,
			totalVolumeUsd: null,
			endsAt: null,
			imageUrl: null,
		} satisfies Wallet.WalletMarketPrediction;
		const source = {
			providerId: "coingecko",
			providerName: "CoinGecko",
			providerUrl: "https://coingecko.com",
			available: true,
			stale: false,
			error: null,
		} satisfies Wallet.WalletMarketOverviewSource;
		const overview = {
			generatedAt: ledgerEntry.updatedAt,
			cacheTtlSeconds: 60,
			stale: false,
			sources: { prices: source, movers: source, predictions: source },
			prices: [price],
			movers: [mover],
			predictions: [prediction],
		} satisfies Wallet.WalletMarketOverviewResponse;

		expect(profile.summary.realizedPnlBnb).toBe("0.1");
		expect(overview.predictions[0]?.highlightedOutcomeProbability).toBe(0.9);
		expectTypeOf<Wallet.WalletTradeSource>().toEqualTypeOf<
			"agent" | "manual"
		>();
		expectTypeOf<Wallet.WalletTradingProfileWindow>().toEqualTypeOf<
			"24h" | "7d" | "30d" | "all"
		>();
		expectTypeOf<Wallet.WalletTradingProfileSourceFilter>().toEqualTypeOf<
			"all" | Wallet.WalletTradeSource
		>();
		expectTypeOf<Wallet.WalletMarketOverviewProviderId>().toEqualTypeOf<
			"coingecko" | "polymarket"
		>();
	});

	it("covers Steward events and wallet key lifecycle results", () => {
		const policy = {
			policyId: "policy-1",
			name: "Daily limit",
			status: "approved",
			reason: "within limit",
		} satisfies Wallet.StewardPolicyResult;
		const approval = {
			status: "rejected",
			policyResults: [{ ...policy, status: "rejected" }],
		} satisfies Wallet.StewardApprovalInfo;
		const addresses = {
			evmAddress: "0xsteward",
			solanaAddress: null,
		} satisfies Wallet.StewardWalletAddressesResponse;
		const nativeBalance = {
			balance: "1000000000000000000",
			formatted: "1",
			symbol: "BNB",
			chainId: 56,
		} satisfies Wallet.StewardBalanceResponse;
		const stewardToken = {
			address: "0xtoken",
			symbol: "USDC",
			name: "USD Coin",
			balance: "2500000",
			formatted: "2.5",
			decimals: 6,
			valueUsd: "2.50",
			logoUrl: tokenBase.logoUrl,
		} satisfies Wallet.StewardTokenBalance;
		const stewardBalances = {
			native: nativeBalance,
			tokens: [stewardToken],
		} satisfies Wallet.StewardTokenBalancesResponse;
		const event = {
			event: "tx.confirmed",
			data: { hash: "0xhash" },
			timestamp: "2026-08-23T00:00:00.000Z",
		} satisfies Wallet.StewardWebhookEvent;
		const events = {
			events: [event],
			nextIndex: 1,
		} satisfies Wallet.StewardWebhookEventsResponse;

		const validation = {
			valid: false,
			chain: "evm",
			address: null,
			error: "invalid key",
		} satisfies Wallet.KeyValidationResult;
		const imported = {
			success: true,
			chain: "solana",
			address: "sol-address",
			error: null,
		} satisfies Wallet.WalletImportResult;
		const generated = {
			chain: "evm",
			address: "0xgenerated",
			privateKey: "0xprivate",
		} satisfies Wallet.WalletGenerateResult;
		const exportRequest = {
			confirm: true,
			exportToken: "one-time-token",
		} satisfies Wallet.WalletExportRequestBody;
		const rejection = {
			status: 429,
			reason: "rate limited",
		} satisfies Wallet.WalletExportRejection;

		expect(signingCapabilities).toContain("steward-cloud");
		expect(webhookEvents).toEqual([
			"tx.pending",
			"tx.approved",
			"tx.denied",
			"tx.confirmed",
		]);
		expect(approval.policyResults[0]?.status).toBe("rejected");
		expect(addresses.solanaAddress).toBeNull();
		expect(stewardBalances.tokens[0]?.formatted).toBe("2.5");
		expect(events.nextIndex).toBe(1);
		expect(validation.error).toBe("invalid key");
		expect(imported.success).toBe(true);
		expect(generated.chain).toBe("evm");
		expect(exportRequest.confirm).toBe(true);
		expect(rejection.status).toBe(429);
		expectTypeOf<
			Exclude<Wallet.StewardWebhookEventType, (typeof webhookEvents)[number]>
		>().toEqualTypeOf<never>();
		expectTypeOf<Wallet.WalletChain>().toEqualTypeOf<"evm" | "solana">();
		expectTypeOf<Wallet.WalletExportRejection["status"]>().toEqualTypeOf<
			400 | 401 | 402 | 403 | 429
		>();
	});
});
