import {
	asUUID,
	ChannelType,
	type Component,
	createUniqueUuid,
	type Entity,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	Service,
	type Task,
	type UUID,
} from "@elizaos/core";

/** Alias for the Component.data field type. */
type ComponentData = Component["data"];

import { v4 as uuidv4 } from "uuid";
import { BirdeyeClient, DexscreenerClient, HeliusClient } from "./clients";
import {
	DEFAULT_TRADING_CONFIG,
	getConvictionMultiplier,
	getLiquidityMultiplier,
	getMarketCapMultiplier,
	getVolumeMultiplier,
	TRUST_LEADERBOARD_WORLD_SEED,
	type TradingConfig,
} from "./config"; // Import the seed
import { formatFullReport } from "./reports";
import { BalancedTrustScoreCalculator } from "./services/balancedTrustScoreCalculator";
import {
	type BuySignalMessage,
	Conviction,
	type HighValueHolder,
	type ICommunityInvestorService,
	type LeaderboardEntry,
	type Position,
	type PositionWithBalance,
	type ProcessedTokenData,
	type Recommendation,
	type RecommendationMetric,
	RecommendationType,
	type RecommenderMetrics,
	type RecommenderMetricsHistory,
	ServiceType,
	SupportedChain,
	type TokenAPIData,
	type TokenMarketData,
	type TokenMetadata,
	type TokenPerformance,
	type TokenRecommendation,
	type TokenSecurityData,
	type TokenTradeData,
	TRUST_MARKETPLACE_COMPONENT_TYPE,
	type Transaction,
	TransactionType,
	type TrustMarketplaceComponentData,
	type UserTrustProfile,
} from "./types";

type ExtractedSignal = {
	messageIndex: number | string;
	isCall: boolean | string;
	tokenMentioned?: string;
	nameMentioned?: string;
	caMentioned?: string;
	chain?: string;
	sentiment?: string;
	conviction?: string;
	llmReasoning?: string;
};

type NormalizedExtractedSignal = Omit<
	ExtractedSignal,
	"messageIndex" | "isCall"
> & {
	messageIndex: number;
	isCall: boolean;
};

function parseRecommendationExtraction(response: string): {
	recommendations: NormalizedExtractedSignal[];
} | null {
	const parsed = parseJsonObject<{ recommendations?: ExtractedSignal[] }>(
		response,
	);

	if (!parsed?.recommendations || !Array.isArray(parsed.recommendations)) {
		return null;
	}

	return {
		recommendations: parsed.recommendations.map((rec) => ({
			...rec,
			messageIndex:
				typeof rec.messageIndex === "number"
					? rec.messageIndex
					: Number.parseInt(String(rec.messageIndex ?? "0"), 10),
			isCall:
				rec.isCall === true || String(rec.isCall).toLowerCase() === "true",
		})),
	};
}

function parseJsonObject<T extends Record<string, unknown>>(
	value: string,
): T | null {
	try {
		const parsed: unknown = JSON.parse(value.trim());
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as T)
			: null;
	} catch {
		return null;
	}
}

// Event types
/**
 * Represents different types of trading events that can occur.
 * @typedef {Object} TradingEvent
 * @property {string} type - The type of trading event.
 * @property {Position} [position] - The position associated with the event. (if type is 'position_opened' or 'position_closed')
 * @property {Transaction} [transaction] - The transaction associated with the event. (if type is 'transaction_added')
 * @property {TokenRecommendation} [recommendation] - The token recommendation associated with the event. (if type is 'recommendation_added')
 * @property {TokenPerformance} [performance] - The token performance associated with the event. (if type is 'token_performance_updated')
 */
export type TradingEvent =
	| { type: "position_opened"; position: Position }
	| { type: "position_closed"; position: Position }
	| { type: "transaction_added"; transaction: Transaction }
	| { type: "recommendation_added"; recommendation: TokenRecommendation }
	| { type: "token_performance_updated"; performance: TokenPerformance };

/**
 * Unified Trading Service that centralizes all trading operations
 */
/**
 * CommunityInvestorService class representing a service for trading on the Solana blockchain.
 * @extends Service
 * @property {string} serviceType - The type of service, set to ServiceType.COMMUNITY_INVESTOR.
 * @property {string} capabilityDescription - Description of the agent's ability to trade on the Solana blockchain.
 * @method storeRecommenderMetrics - Store entity metrics and cache for 5 minutes.
 * @method storeRecommenderMetricsHistory - Store entity metrics history.
 */
export class CommunityInvestorService
	extends Service
	implements ICommunityInvestorService
{
	static override serviceType = ServiceType.COMMUNITY_INVESTOR;
	public capabilityDescription =
		"Manages community-driven investment trust scores and recommendations.";

	// Client instances
	private birdeyeClient: BirdeyeClient;
	private dexscreenerClient: DexscreenerClient;
	private heliusClient: HeliusClient | null = null;

	// Configuration
	tradingConfig: TradingConfig;

	private apiKeys: {
		birdeye?: string;
		moralis?: string;
		dexscreener?: string;
	} = {};

	private balancedTrustCalculator: BalancedTrustScoreCalculator;

	// Constants can be defined here or loaded from config/settings
	private readonly POSITIVE_TRADE_THRESHOLD = 10; // Trust score above this might trigger a trade
	private readonly NEUTRAL_MARGIN = 5; // Trust scores within +/- this from 0 are neutral
	private readonly RECENCY_WEIGHT_MONTHS = 6;
	private readonly USER_TRADE_COOLDOWN_HOURS = 12;
	private readonly METRIC_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 1 day to re-evaluate metrics

	// Add this property to the class
	private userRegistry: Set<UUID> = new Set();
	public readonly componentWorldId: UUID;
	public readonly componentRoomId: UUID; // This will be the same as componentWorldId

	constructor(protected override runtime: IAgentRuntime) {
		super(runtime);

		// Initialize the balanced trust calculator
		this.balancedTrustCalculator = new BalancedTrustScoreCalculator();

		// Generate the consistent World ID and Room ID for this plugin's components
		this.componentWorldId = createUniqueUuid(
			runtime,
			TRUST_LEADERBOARD_WORLD_SEED,
		);
		this.componentRoomId = this.componentWorldId; // Use the same ID for room context of components
		logger.info(
			`[CommunityInvestorService] Using Component World/Room ID: ${this.componentWorldId}`,
		);

		// Ensure this world and room exist for the plugin's components
		this.ensurePluginComponentContext();

		// Initialize API clients
		this.birdeyeClient = BirdeyeClient.createFromRuntime(runtime);
		this.dexscreenerClient = DexscreenerClient.createFromRuntime(runtime);

		try {
			this.heliusClient = HeliusClient.createFromRuntime(runtime);
		} catch (error) {
			logger.warn(
				"Failed to initialize Helius client, holder data will be limited:",
				error,
			);
		}

		// Merge provided config with defaults
		this.tradingConfig = DEFAULT_TRADING_CONFIG;

		this.initialize(runtime);
		this.registerTaskWorkers(runtime); // Register task workers on service instantiation
	}

	static async start(
		runtime: IAgentRuntime,
	): Promise<CommunityInvestorService> {
		const service = new CommunityInvestorService(runtime);
		return service;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		const service = runtime.getService("trading");
		if (service) {
			await service.stop?.();
		}
	}

	async stop(): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Process a buy signal from an entity
	 */
	async processBuySignal(
		buySignal: BuySignalMessage,
		entity: Entity,
	): Promise<Position | null> {
		logger.debug("processing buy signal", buySignal, entity);
		try {
			// Ensure entity has a valid ID
			if (!entity.id) {
				logger.error("Entity ID is required for processing buy signal");
				return null;
			}

			// Validate the token
			const tokenPerformance = await this.getOrFetchTokenPerformance(
				buySignal.tokenAddress,
				buySignal.chain || this.tradingConfig.defaultChain,
			);

			if (!tokenPerformance) {
				logger.error(`Token not found: ${buySignal.tokenAddress}`);
				return null;
			}

			// Check if token meets criteria
			if (!this.validateToken(tokenPerformance)) {
				logger.error(`Token failed validation: ${buySignal.tokenAddress}`);
				return null;
			}

			// Create recommendation
			const recommendation = await this.createTokenRecommendation(
				entity.id,
				tokenPerformance,
				buySignal.conviction || Conviction.MEDIUM,
				RecommendationType.BUY,
			);

			if (!recommendation) {
				logger.error(
					`Failed to create recommendation for token: ${buySignal.tokenAddress}`,
				);
				return null;
			}

			// Calculate buy amount
			const buyAmount = this.calculateBuyAmount(
				entity,
				buySignal.conviction || Conviction.MEDIUM,
				tokenPerformance,
			);

			// Create position
			const position = await this.createPosition(
				recommendation.id,
				entity.id,
				buySignal.tokenAddress,
				buySignal.walletAddress || "simulation",
				buyAmount,
				tokenPerformance.price?.toString() || "0",
				buySignal.isSimulation || this.tradingConfig.forceSimulation,
			);

			if (!position) {
				logger.error(
					`Failed to create position for token: ${buySignal.tokenAddress}`,
				);
				return null;
			}

			// Record transaction
			await this.recordTransaction(
				position.id as UUID,
				buySignal.tokenAddress,
				TransactionType.BUY,
				buyAmount,
				tokenPerformance.price || 0,
				position.isSimulation,
			);

			// Emit event
			// this.emitEvent({ type: 'position_opened', position });

			return position;
		} catch (error) {
			logger.error("Error processing buy signal:", error);
			return null;
		}
	}

	/**
	 * Process a sell signal for an existing position
	 */
	async processSellSignal(
		positionId: UUID,
		_sellRecommenderId: UUID,
	): Promise<boolean> {
		try {
			logger.debug("processing sell signal", positionId, _sellRecommenderId);
			// Get position
			const position = await this.getPosition(positionId);
			if (!position) {
				logger.error(`Position not found: ${positionId}`);
				return false;
			}

			// Check if position is already closed
			if (position.closedAt) {
				logger.error(`Position already closed: ${positionId}`);
				return false;
			}

			// Get token performance
			const tokenPerformance = await this.getOrFetchTokenPerformance(
				position.tokenAddress,
				position.chain,
			);

			if (!tokenPerformance) {
				logger.error(`Token not found: ${position.tokenAddress}`);
				return false;
			}

			// Calculate performance metrics
			const initialPrice = Number.parseFloat(position.initialPrice);
			const currentPrice = tokenPerformance.price || 0;
			const priceChange =
				initialPrice > 0 ? (currentPrice - initialPrice) / initialPrice : 0;

			// Update position
			const updatedPosition: Position = {
				...position,
				currentPrice: currentPrice.toString(),
				closedAt: new Date(),
			};

			// Store updated position
			await this.storePosition(updatedPosition);

			// Record transaction
			await this.recordTransaction(
				position.id as UUID,
				position.tokenAddress,
				TransactionType.SELL,
				BigInt(position.amount),
				currentPrice,
				position.isSimulation,
			);

			// Update entity metrics
			await this.updateRecommenderMetrics(position.entityId, priceChange * 100);

			// Emit event
			// this.emitEvent({ type: 'position_closed', position: updatedPosition });

			return true;
		} catch (error) {
			logger.error("Error processing sell signal:", error);
			return false;
		}
	}

	/**
	 * Handle a recommendation from a entity
	 */
	async handleRecommendation(
		entity: Entity,
		recommendation: {
			chain: string;
			tokenAddress: string;
			conviction: Conviction;
			type: RecommendationType;
			timestamp: Date;
			metadata?: Record<string, any>;
		},
	): Promise<Position | null> {
		try {
			logger.debug("handling recommendation", entity, recommendation);

			// Ensure entity has a valid ID
			if (!entity.id) {
				logger.error("Entity ID is required for handling recommendation");
				return null;
			}

			// Get token performance
			const tokenPerformance = await this.getOrFetchTokenPerformance(
				recommendation.tokenAddress,
				recommendation.chain,
			);

			if (!tokenPerformance) {
				logger.error(`Token not found: ${recommendation.tokenAddress}`);
				return null;
			}

			// Create recommendation
			const tokenRecommendation = await this.createTokenRecommendation(
				entity.id,
				tokenPerformance,
				recommendation.conviction,
				recommendation.type,
			);

			if (!tokenRecommendation) {
				logger.error(
					`Failed to create recommendation for token: ${recommendation.tokenAddress}`,
				);
				return null;
			}

			// For buy recommendations, create a position
			if (recommendation.type === RecommendationType.BUY) {
				// Calculate buy amount
				const buyAmount = this.calculateBuyAmount(
					entity,
					recommendation.conviction,
					tokenPerformance,
				);

				// Create position
				const position = await this.createPosition(
					tokenRecommendation.id,
					entity.id,
					recommendation.tokenAddress,
					"simulation", // Use simulation wallet by default
					buyAmount,
					tokenPerformance.price?.toString() || "0",
					true, // Simulation by default
				);

				if (!position) {
					logger.error(
						`Failed to create position for token: ${recommendation.tokenAddress}`,
					);
					return null;
				}

				// Record transaction
				await this.recordTransaction(
					position.id as UUID,
					recommendation.tokenAddress,
					TransactionType.BUY,
					buyAmount,
					tokenPerformance.price || 0,
					true, // Simulation by default
				);

				// Return position
				return position;
			}

			return null;
		} catch (error) {
			logger.error("Error handling recommendation:", error);
			return null;
		}
	}

	/**
	 * Check if a wallet is registered for a chain
	 */
	hasWallet(chain: string): boolean {
		logger.debug("hasWallet", chain);
		// This implementation would check if a wallet config exists for the specified chain
		return chain.toLowerCase() === "solana"; // Assuming Solana is always supported
	}

	// ===================== TOKEN PROVIDER METHODS =====================

	/**
	 * Get token overview data
	 */
	async getTokenOverview(
		chain: string,
		tokenAddress: string,
		forceRefresh = false,
	): Promise<TokenMetadata & TokenMarketData> {
		try {
			logger.debug("getting token overview", chain, tokenAddress, forceRefresh);
			// Check cache first unless force refresh is requested
			if (!forceRefresh) {
				const cacheKey = `token:${chain}:${tokenAddress}:overview`;
				const cachedData = await this.runtime.getCache<
					TokenMetadata & TokenMarketData
				>(cacheKey);

				if (cachedData) {
					return cachedData;
				}

				// Also check in memory
				const tokenPerformance = await this.getTokenPerformance(
					tokenAddress,
					chain,
				);
				if (tokenPerformance) {
					const tokenData = {
						chain: tokenPerformance.chain || chain,
						address: tokenPerformance.address || tokenAddress,
						name: tokenPerformance.name || "",
						symbol: tokenPerformance.symbol || "",
						decimals: tokenPerformance.decimals || 0,
						metadata: tokenPerformance.metadata || {},
						price: tokenPerformance.price || 0,
						priceUsd: tokenPerformance.price?.toString() || "0",
						price24hChange: tokenPerformance.price24hChange || 0,
						marketCap: tokenPerformance.currentMarketCap || 0,
						liquidityUsd: tokenPerformance.liquidity || 0,
						volume24h: tokenPerformance.volume || 0,
						volume24hChange: tokenPerformance.volume24hChange || 0,
						trades: tokenPerformance.trades || 0,
						trades24hChange: tokenPerformance.trades24hChange || 0,
						uniqueWallet24h: 0, // Would need to be fetched
						uniqueWallet24hChange: 0, // Would need to be fetched
						holders: tokenPerformance.holders || 0,
					};

					// Cache the token data
					await this.runtime.setCache<TokenMetadata & TokenMarketData>(
						cacheKey,
						tokenData,
					); // Cache for 5 minutes

					return tokenData;
				}
			}

			// Need to fetch fresh data
			if (chain.toLowerCase() === "solana") {
				const [dexScreenerData, birdeyeData] = await Promise.all([
					this.dexscreenerClient.searchForHighestLiquidityPair(
						tokenAddress,
						chain,
						{
							expires: "5m",
						},
					),
					this.birdeyeClient.fetchTokenOverview(
						tokenAddress,
						{ expires: "5m" },
						forceRefresh,
					),
				]);

				// If we have DexScreener data, it's typically more reliable for prices and liquidity
				const tokenData = {
					chain,
					address: tokenAddress,
					name: birdeyeData?.name || dexScreenerData?.baseToken?.name || "",
					symbol:
						birdeyeData?.symbol || dexScreenerData?.baseToken?.symbol || "",
					decimals: birdeyeData?.decimals || 9, // Default for Solana tokens
					metadata: {
						logoURI: birdeyeData?.logoURI || "",
						pairAddress: dexScreenerData?.pairAddress || "",
						dexId: dexScreenerData?.dexId || "",
					},
					price: Number.parseFloat(dexScreenerData?.priceUsd || "0"),
					priceUsd: dexScreenerData?.priceUsd || "0",
					price24hChange: dexScreenerData?.priceChange?.h24 || 0,
					marketCap: dexScreenerData?.marketCap || 0,
					liquidityUsd: dexScreenerData?.liquidity?.usd || 0,
					volume24h: dexScreenerData?.volume?.h24 || 0,
					volume24hChange: 0, // Need to calculate from historical data
					trades: 0, // Would need additional data
					trades24hChange: 0, // Would need additional data
					uniqueWallet24h: 0, // Would need additional data
					uniqueWallet24hChange: 0, // Would need additional data
					holders: 0,
				};

				// Cache the token data
				const cacheKey = `token:${chain}:${tokenAddress}:overview`;
				await this.runtime.setCache<TokenMetadata & TokenMarketData>(
					cacheKey,
					tokenData,
				); // Cache for 5 minutes

				return tokenData;
			}
			throw new Error(`Chain ${chain} not supported`);
		} catch (error) {
			logger.error(`Error fetching token overview for ${tokenAddress}:`, error);
			throw error;
		}
	}

	/**
	 * Resolve a ticker to a token address
	 */
	async resolveTicker(
		ticker: string,
		chain: SupportedChain = SupportedChain.SOLANA,
		contextMessages?: Memory[], // Context might be used to disambiguate if multiple matches
	): Promise<{
		address: string;
		chain: SupportedChain;
		ticker?: string;
	} | null> {
		logger.debug(
			`[CommunityInvestorService] Attempting to resolve ticker "${ticker}" on chain ${chain}`,
		);

		const cleanTicker = ticker.startsWith("$")
			? ticker.substring(1).toUpperCase()
			: ticker.toUpperCase();

		// Check context messages first if they contain a contract address for this ticker recently
		if (contextMessages) {
			for (const msg of contextMessages.slice().reverse()) {
				// Check recent first
				if (
					msg.content?.text?.includes(ticker) &&
					msg.content.text.length > ticker.length + 5
				) {
					// Basic check for potential address patterns
					// Split by spaces, parentheses, commas, then iterate and validate
					const potentialAddressParts = msg.content.text.split(/[\s(),]+/);
					for (const part of potentialAddressParts) {
						// Solana addresses: 32-44 alphanumeric characters
						if (
							chain === SupportedChain.SOLANA &&
							part.length >= 32 &&
							part.length <= 44 &&
							/^[a-zA-Z0-9]+$/.test(part)
						) {
							logger.info(
								`[CommunityInvestorService] Found potential Solana address ${part} for ticker ${ticker} in context.`,
							);
							return {
								address: part,
								chain: SupportedChain.SOLANA,
								ticker: cleanTicker,
							};
						}
						// Ethereum/Base addresses: 0x followed by 40 hex characters
						if (
							(chain === SupportedChain.ETHEREUM ||
								chain === SupportedChain.BASE) &&
							part.length === 42 &&
							part.toLowerCase().startsWith("0x") &&
							/^0x[a-fA-F0-9]{40}$/.test(part)
						) {
							logger.info(
								`[CommunityInvestorService] Found potential Ethereum/Base address ${part} for ticker ${ticker} in context.`,
							);
							return {
								address: part,
								chain: chain,
								ticker: cleanTicker,
							};
						}
					}
				}
			}
		}

		// Known tokens on Solana
		if (chain === SupportedChain.SOLANA) {
			const knownSolanaTokens: Record<string, string> = {
				SOL: "So11111111111111111111111111111111111111112",
				USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
				WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzL7WDb43cuQu2",
				BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
				JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
				RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
				ORCA: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",
				SRM: "SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt",
				FTT: "AGFEad2et2ZJif9jaGpdMixQqvW5i81aBdvKe7PHNfz3",
			};

			if (knownSolanaTokens[cleanTicker]) {
				return {
					address: knownSolanaTokens[cleanTicker],
					chain: SupportedChain.SOLANA,
					ticker: cleanTicker,
				};
			}

			// Try to search using DexScreener for Solana
			try {
				const searchResults = await this.dexscreenerClient.search(cleanTicker, {
					expires: "5m",
				});
				if (searchResults?.pairs && searchResults.pairs.length > 0) {
					// Find the most liquid pair for this token
					const bestPair = searchResults.pairs
						.filter(
							(pair) => pair.baseToken.symbol.toUpperCase() === cleanTicker,
						)
						.sort(
							(a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
						)[0];

					if (bestPair) {
						logger.info(
							`[CommunityInvestorService] Found ${cleanTicker} via DexScreener: ${bestPair.baseToken.address}`,
						);
						return {
							address: bestPair.baseToken.address,
							chain: SupportedChain.SOLANA,
							ticker: cleanTicker,
						};
					}
				}
			} catch (error) {
				logger.warn(
					`[CommunityInvestorService] DexScreener search failed for ${cleanTicker}:`,
					error,
				);
			}
		}

		// Known tokens on Ethereum
		else if (chain === SupportedChain.ETHEREUM) {
			const knownEthereumTokens: Record<string, string> = {
				ETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
				USDC: "0xA0b86a33E6441c69De69b9A87e20b88dd75B61FC",
				USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
				DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
				LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
				UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
				WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
			};

			if (knownEthereumTokens[cleanTicker]) {
				return {
					address: knownEthereumTokens[cleanTicker],
					chain: SupportedChain.ETHEREUM,
					ticker: cleanTicker,
				};
			}

			// Try to search using DexScreener for Ethereum
			try {
				const searchResults = await this.dexscreenerClient.search(cleanTicker, {
					expires: "5m",
				});
				if (searchResults?.pairs && searchResults.pairs.length > 0) {
					const bestPair = searchResults.pairs
						.filter(
							(pair) =>
								pair.chainId.toLowerCase() === "ethereum" &&
								pair.baseToken.symbol.toUpperCase() === cleanTicker,
						)
						.sort(
							(a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
						)[0];

					if (bestPair) {
						logger.info(
							`[CommunityInvestorService] Found ${cleanTicker} via DexScreener on Ethereum: ${bestPair.baseToken.address}`,
						);
						return {
							address: bestPair.baseToken.address,
							chain: SupportedChain.ETHEREUM,
							ticker: cleanTicker,
						};
					}
				}
			} catch (error) {
				logger.warn(
					`[CommunityInvestorService] DexScreener search failed for ${cleanTicker} on Ethereum:`,
					error,
				);
			}
		}

		// Known tokens on Base
		else if (chain === SupportedChain.BASE) {
			const knownBaseTokens: Record<string, string> = {
				ETH: "0x4200000000000000000000000000000000000006", // Base ETH
				USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
				WETH: "0x4200000000000000000000000000000000000006",
			};

			if (knownBaseTokens[cleanTicker]) {
				return {
					address: knownBaseTokens[cleanTicker],
					chain: SupportedChain.BASE,
					ticker: cleanTicker,
				};
			}

			// Try to search using DexScreener for Base
			try {
				const searchResults = await this.dexscreenerClient.search(cleanTicker, {
					expires: "5m",
				});
				if (searchResults?.pairs && searchResults.pairs.length > 0) {
					const bestPair = searchResults.pairs
						.filter(
							(pair) =>
								pair.chainId.toLowerCase() === "base" &&
								pair.baseToken.symbol.toUpperCase() === cleanTicker,
						)
						.sort(
							(a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0),
						)[0];

					if (bestPair) {
						logger.info(
							`[CommunityInvestorService] Found ${cleanTicker} via DexScreener on Base: ${bestPair.baseToken.address}`,
						);
						return {
							address: bestPair.baseToken.address,
							chain: SupportedChain.BASE,
							ticker: cleanTicker,
						};
					}
				}
			} catch (error) {
				logger.warn(
					`[CommunityInvestorService] DexScreener search failed for ${cleanTicker} on Base:`,
					error,
				);
			}
		}

		logger.warn(
			`[CommunityInvestorService] Could not resolve ticker ${ticker} on chain ${chain}`,
		);
		return null;
	}

	/**
	 * Get current price for a token
	 */
	async getCurrentPrice(chain: string, tokenAddress: string): Promise<number> {
		logger.debug("getting current price", chain, tokenAddress);
		try {
			// Check cache first
			const cacheKey = `token:${chain}:${tokenAddress}:price`;
			const cachedPrice = await this.runtime.getCache<string>(cacheKey);

			if (cachedPrice) {
				return Number.parseFloat(cachedPrice);
			}

			// Try to get from token performance
			const token = await this.getTokenPerformance(tokenAddress, chain);
			if (token?.price) {
				// Cache the price
				await this.runtime.setCache<string>(cacheKey, token.price.toString()); // Cache for 1 minute
				return token.price;
			}

			// Fetch fresh price
			if (chain.toLowerCase() === "solana") {
				const price = await this.birdeyeClient.fetchPrice(tokenAddress, {
					chain: "solana",
				});

				// Cache the price
				await this.runtime.setCache<string>(cacheKey, price.toString()); // Cache for 1 minute

				return price;
			}
			throw new Error(`Chain ${chain} not supported for price fetching`);
		} catch (error) {
			logger.error(`Error fetching current price for ${tokenAddress}:`, error);
			return 0;
		}
	}

	/**
	 * Determine if a token should be traded
	 */
	async shouldTradeToken(
		chain: string,
		tokenAddress: string,
	): Promise<boolean> {
		logger.debug("shouldTradeToken", chain, tokenAddress);
		try {
			const tokenData = await this.getProcessedTokenData(chain, tokenAddress);

			if (!tokenData) return false;

			// Get the key metrics
			const { tradeData, security, dexScreenerData } = tokenData;

			if (!dexScreenerData?.pairs || dexScreenerData.pairs.length === 0) {
				return false;
			}

			const pair = dexScreenerData.pairs[0];

			// Check liquidity
			if (
				!pair.liquidity ||
				pair.liquidity.usd < this.tradingConfig.minLiquidityUsd
			) {
				return false;
			}

			// Check market cap
			if (
				!pair.marketCap ||
				pair.marketCap > this.tradingConfig.maxMarketCapUsd
			) {
				return false;
			}

			// Check for suspicious holder distribution
			if (security && security.top10HolderPercent > 80) {
				return false;
			}

			// Check for suspicious volume
			if (tradeData && tradeData.volume_24h_usd < 1000) {
				return false;
			}

			return true;
		} catch (error) {
			logger.error(
				`Error checking if token ${tokenAddress} should be traded:`,
				error,
			);
			return false;
		}
	}

	/**
	 * Get processed token data with security and trade information
	 */
	async getProcessedTokenData(
		chain: string,
		tokenAddress: string,
	): Promise<ProcessedTokenData | null> {
		logger.debug("getting processed token data", chain, tokenAddress);
		try {
			// Check cache first
			const cacheKey = `token:${chain}:${tokenAddress}:processed`;
			const cachedData =
				await this.runtime.getCache<ProcessedTokenData>(cacheKey);

			if (cachedData) {
				return cachedData;
			}

			// Use token provider functionality to get complete token data
			if (chain.toLowerCase() === "solana") {
				// Get DexScreener data
				const dexScreenerData = await this.dexscreenerClient.search(
					tokenAddress,
					{
						expires: "5m",
					},
				);

				// Try to get token data from Birdeye
				let tokenTradeData: TokenTradeData;
				let tokenSecurityData: TokenSecurityData;

				try {
					tokenTradeData = await this.birdeyeClient.fetchTokenTradeData(
						tokenAddress,
						{
							chain: "solana",
							expires: "5m",
						},
					);

					tokenSecurityData = await this.birdeyeClient.fetchTokenSecurity(
						tokenAddress,
						{
							chain: "solana",
							expires: "5m",
						},
					);
				} catch (error) {
					logger.error(`Error fetching token data for ${tokenAddress}:`, error);
					return null;
				}

				let tokenInfo: any;

				// Analyze holder distribution
				const holderDistributionTrend =
					await this.analyzeHolderDistribution(tokenTradeData);

				// Try to get holder data if Helius client is available
				let highValueHolders: HighValueHolder[] = [];
				let highSupplyHoldersCount = 0;

				if (this.heliusClient) {
					try {
						const holders = await this.heliusClient.fetchHolderList(
							tokenAddress,
							{
								expires: "30m",
							},
						);

						// Calculate high value holders
						const tokenPrice = Number.parseFloat(
							tokenTradeData.price.toString(),
						);
						highValueHolders = holders
							.filter((holder) => {
								const balance = Number.parseFloat(holder.balance);
								const balanceUsd = balance * tokenPrice;
								return balanceUsd > 5; // More than $5 USD
							})
							.map((holder) => ({
								holderAddress: holder.address,
								balanceUsd: (
									Number.parseFloat(holder.balance) * tokenPrice
								).toFixed(2),
							}));

						// Calculate high supply holders
						const totalSupply = tokenInfo?.totalSupply || "0";
						highSupplyHoldersCount = holders.filter((holder) => {
							const holderRatio =
								Number.parseFloat(holder.balance) /
								Number.parseFloat(totalSupply);
							return holderRatio > 0.02; // More than 2% of supply
						}).length;
					} catch (error) {
						logger.warn(
							`Error fetching holder data for ${tokenAddress}:`,
							error,
						);
						// Continue without holder data
					}
				}

				// Check if there were any trades in last 24h
				const recentTrades = tokenTradeData.volume_24h > 0;

				// Check if token is listed on DexScreener
				const isDexScreenerListed = dexScreenerData.pairs.length > 0;
				const isDexScreenerPaid = dexScreenerData.pairs.some(
					(pair) => pair.boosts && pair.boosts.active > 0,
				);

				const processedData: ProcessedTokenData = {
					token: {
						address: tokenAddress,
						name:
							tokenInfo?.name ||
							dexScreenerData.pairs[0]?.baseToken?.name ||
							"",
						symbol:
							tokenInfo?.symbol ||
							dexScreenerData.pairs[0]?.baseToken?.symbol ||
							"",
						decimals: tokenInfo?.decimals || 9, // Default for Solana
						logoURI: tokenInfo?.info?.imageThumbUrl || "",
					},
					security: tokenSecurityData,
					tradeData: tokenTradeData,
					holderDistributionTrend,
					highValueHolders,
					recentTrades,
					highSupplyHoldersCount,
					dexScreenerData,
					isDexScreenerListed,
					isDexScreenerPaid,
				};

				// Cache the processed data
				await this.runtime.setCache<ProcessedTokenData>(
					cacheKey,
					processedData,
				); // Cache for 5 minutes

				return processedData;
			}
			throw new Error(`Chain ${chain} not supported for processed token data`);
		} catch (error) {
			logger.error(
				`Error fetching processed token data for ${tokenAddress}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Analyze holder distribution trend
	 */
	private async analyzeHolderDistribution(
		tradeData: TokenTradeData,
	): Promise<string> {
		logger.debug("analyzing holder distribution", tradeData);
		// Define the time intervals to consider
		const intervals = [
			{
				period: "30m",
				change: tradeData.unique_wallet_30m_change_percent,
			},
			{ period: "1h", change: tradeData.unique_wallet_1h_change_percent },
			{ period: "2h", change: tradeData.unique_wallet_2h_change_percent },
			{ period: "4h", change: tradeData.unique_wallet_4h_change_percent },
			{ period: "8h", change: tradeData.unique_wallet_8h_change_percent },
			{
				period: "24h",
				change: tradeData.unique_wallet_24h_change_percent,
			},
		];

		// Calculate the average change percentage
		const validChanges = intervals
			.map((interval) => interval.change)
			.filter((change) => change !== null && change !== undefined) as number[];

		if (validChanges.length === 0) {
			return "stable";
		}

		const averageChange =
			validChanges.reduce((acc, curr) => acc + curr, 0) / validChanges.length;

		const increaseThreshold = 10; // e.g., average change > 10%
		const decreaseThreshold = -10; // e.g., average change < -10%

		if (averageChange > increaseThreshold) {
			return "increasing";
		}
		if (averageChange < decreaseThreshold) {
			return "decreasing";
		}
		return "stable";
	}

	// ===================== SCORE MANAGER METHODS =====================

	/**
	 * Update token performance data
	 */
	async updateTokenPerformance(
		chain: string,
		tokenAddress: string,
	): Promise<TokenPerformance> {
		logger.debug("updating token performance", chain, tokenAddress);
		try {
			const tokenData = await this.getTokenOverview(chain, tokenAddress, true);

			const performance: TokenPerformance = {
				chain,
				address: tokenAddress,
				name: tokenData.name,
				symbol: tokenData.symbol,
				decimals: tokenData.decimals,
				price: Number.parseFloat(tokenData.priceUsd),
				volume: tokenData.volume24h,
				liquidity: tokenData.liquidityUsd,
				currentMarketCap: tokenData.marketCap,
				holders: tokenData.holders,
				price24hChange: tokenData.price24hChange,
				volume24hChange: tokenData.volume24hChange,
				metadata: tokenData.metadata,
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			// Store in memory
			await this.storeTokenPerformance(performance);

			// Emit event
			/* this.emitEvent({
        type: 'token_performance_updated',
        performance,
      }); */

			return performance;
		} catch (error) {
			logger.error(
				`Error updating token performance for ${tokenAddress}:`,
				error,
			);
			throw error;
		}
	}

	/**
	 * Calculate risk score for a token
	 */
	calculateRiskScore(token: TokenPerformance): number {
		logger.debug("calculating risk score", token);
		let score = 50; // Base score

		// Adjust based on liquidity
		const liquidity = token.liquidity || 0;
		score -= getLiquidityMultiplier(liquidity);

		// Adjust based on market cap
		const marketCap = token.currentMarketCap || 0;
		score += getMarketCapMultiplier(marketCap);

		// Adjust based on volume
		const volume = token.volume || 0;
		score -= getVolumeMultiplier(volume);

		// Risk adjustments for known issues
		if (token.rugPull) score += 30;
		if (token.isScam) score += 30;
		if (token.rapidDump) score += 15;
		if (token.suspiciousVolume) score += 15;

		// Clamp between 0-100
		return Math.max(0, Math.min(100, score));
	}

	/**
	 * Update entity metrics based on their recommendation performance
	 */
	async updateRecommenderMetrics(
		entityId: UUID,
		performance = 0,
	): Promise<void> {
		logger.debug("updating recommender metrics", entityId, performance);
		const metrics = await this.getRecommenderMetrics(entityId);

		if (!metrics) {
			// Initialize metrics if they don't exist
			await this.initializeRecommenderMetrics(entityId, "default");
			return;
		}

		// Update metrics
		const updatedMetrics: RecommenderMetrics = {
			...metrics,
			totalRecommendations: metrics.totalRecommendations + 1,
			successfulRecs:
				performance > 0 ? metrics.successfulRecs + 1 : metrics.successfulRecs,
			avgTokenPerformance:
				(metrics.avgTokenPerformance * metrics.totalRecommendations +
					performance) /
				(metrics.totalRecommendations + 1),
			trustScore: this.calculateTrustScore(metrics, performance),
		};

		// Store updated metrics
		await this.storeRecommenderMetrics(updatedMetrics);

		// Also store in history
		const historyEntry: RecommenderMetricsHistory = {
			entityId,
			metrics: updatedMetrics,
			timestamp: new Date(),
		};

		await this.storeRecommenderMetricsHistory(historyEntry);
	}

	/**
	 * Calculate trust score based on metrics and new performance
	 */
	private calculateTrustScore(
		metrics: RecommenderMetrics,
		newPerformance: number,
	): number {
		logger.debug("calculating trust score", metrics, newPerformance);
		// Weight factors
		const HISTORY_WEIGHT = 0.7;
		const NEW_PERFORMANCE_WEIGHT = 0.3;

		// Calculate success rate
		const newSuccessRate =
			(metrics.successfulRecs + (newPerformance > 0 ? 1 : 0)) /
			(metrics.totalRecommendations + 1);

		// Calculate consistency (based on standard deviation of performance)
		// This is a simplified approach
		const consistencyScore = metrics.consistencyScore || 50;

		// Calculate new trust score
		const newTrustScore =
			metrics.trustScore * HISTORY_WEIGHT +
			(newPerformance > 0 ? 100 : 0) * NEW_PERFORMANCE_WEIGHT;

		// Adjust based on success rate
		const successFactor = newSuccessRate * 100;

		// Combine scores with weights
		const combinedScore =
			newTrustScore * 0.6 + successFactor * 0.3 + consistencyScore * 0.1;

		// Clamp between 0-100
		return Math.max(0, Math.min(100, combinedScore));
	}

	// ===================== POSITION METHODS =====================

	/**
	 * Get or fetch token performance data
	 */
	private async getOrFetchTokenPerformance(
		tokenAddress: string,
		chain: string,
	): Promise<TokenPerformance | null> {
		logger.debug("getting or fetching token performance", tokenAddress, chain);
		try {
			// Try to get from memory first
			let tokenPerformance = await this.getTokenPerformance(
				tokenAddress,
				chain,
			);

			// If not found, fetch from API
			if (!tokenPerformance) {
				const tokenOverview = await this.getTokenOverview(chain, tokenAddress);

				// Convert token overview to token performance
				tokenPerformance = {
					chain,
					address: tokenAddress,
					name: tokenOverview.name,
					symbol: tokenOverview.symbol,
					decimals: tokenOverview.decimals,
					price: Number.parseFloat(tokenOverview.priceUsd),
					volume: tokenOverview.volume24h,
					price24hChange: tokenOverview.price24hChange,
					liquidity: tokenOverview.liquidityUsd,
					holders: tokenOverview.holders,
					createdAt: new Date(),
					updatedAt: new Date(),
				};

				// Store in memory if found
				if (tokenPerformance) {
					await this.storeTokenPerformance(tokenPerformance);
				}
			}

			return tokenPerformance;
		} catch (error) {
			logger.error(
				`Error fetching token performance for ${tokenAddress}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Validate if a token meets trading criteria
	 */
	private validateToken(token: TokenPerformance): boolean {
		// Skip validation for simulation tokens
		if (token.address?.startsWith("sim_")) {
			return true;
		}

		// Check for scam or rug pull flags
		if (token.isScam || token.rugPull) {
			return false;
		}

		// Check liquidity
		const liquidity = token.liquidity || 0;
		if (liquidity < this.tradingConfig.minLiquidityUsd) {
			return false;
		}

		// Check market cap
		const marketCap = token.currentMarketCap || 0;
		if (marketCap > this.tradingConfig.maxMarketCapUsd) {
			return false;
		}

		return true;
	}

	/**
	 * Create a token recommendation
	 */
	private async createTokenRecommendation(
		entityId: UUID,
		token: TokenPerformance,
		conviction: Conviction = Conviction.MEDIUM,
		type: RecommendationType = RecommendationType.BUY,
	): Promise<TokenRecommendation | null> {
		logger.debug(
			"creating token recommendation",
			entityId,
			token,
			conviction,
			type,
		);
		try {
			const recommendation: TokenRecommendation = {
				id: uuidv4() as UUID,
				entityId,
				chain: token.chain || this.tradingConfig.defaultChain,
				tokenAddress: token.address || "",
				type,
				conviction,
				initialMarketCap: (token.initialMarketCap || 0).toString(),
				initialLiquidity: (token.liquidity || 0).toString(),
				initialPrice: (token.price || 0).toString(),
				marketCap: (token.currentMarketCap || 0).toString(),
				liquidity: (token.liquidity || 0).toString(),
				price: (token.price || 0).toString(),
				rugPull: token.rugPull || false,
				isScam: token.isScam || false,
				riskScore: this.calculateRiskScore(token),
				performanceScore: 0,
				metadata: {},
				status: "ACTIVE",
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			// Store in memory
			await this.storeTokenRecommendation(recommendation);

			// Emit event
			/* this.emitEvent({
        type: 'recommendation_added',
        recommendation,
      }); */

			return recommendation;
		} catch (error) {
			logger.error("Error creating token recommendation:", error);
			return null;
		}
	}

	/**
	 * Calculate buy amount based on entity trust score and conviction
	 */
	private calculateBuyAmount(
		entity: Entity,
		conviction: Conviction,
		token: TokenPerformance,
	): bigint {
		logger.debug("calculating buy amount", entity, conviction, token);
		// Get entity trust score from metrics
		let trustScore = 50; // Default value

		// Try to get actual metrics if entity has an ID
		if (entity.id) {
			const metricsPromise = this.getRecommenderMetrics(entity.id);
			metricsPromise
				.then((metrics) => {
					if (metrics) {
						trustScore = metrics.trustScore;
					}
				})
				.catch((error) => {
					logger.error(`Error getting entity metrics for ${entity.id}:`, error);
				});
		}

		// Get base amount from config
		const {
			baseAmount,
			minAmount,
			maxAmount,
			trustScoreMultiplier,
			convictionMultiplier,
		} = this.tradingConfig.buyAmountConfig;

		// Calculate multipliers
		const trustMultiplier = 1 + (trustScore / 100) * trustScoreMultiplier;
		const convMultiplier = getConvictionMultiplier(conviction);

		// Apply multipliers to base amount
		let amount = baseAmount * trustMultiplier * convMultiplier;

		// Apply token-specific multipliers
		if (token.liquidity) {
			amount *= getLiquidityMultiplier(token.liquidity);
		}

		// Ensure amount is within bounds
		amount = Math.max(minAmount, Math.min(maxAmount, amount));

		// Convert to bigint (in smallest units)
		return BigInt(Math.floor(amount * 1e9)); // Convert to lamports (SOL smallest unit)
	}

	/**
	 * Create a new position
	 */
	private async createPosition(
		recommendationId: UUID,
		entityId: UUID,
		tokenAddress: string,
		walletAddress: string,
		amount: bigint,
		price: string,
		isSimulation: boolean,
	): Promise<Position | null> {
		logger.debug(
			"creating position",
			recommendationId,
			entityId,
			tokenAddress,
			walletAddress,
			amount,
			price,
			isSimulation,
		);
		try {
			const position: Position = {
				id: uuidv4() as UUID,
				chain: this.tradingConfig.defaultChain,
				tokenAddress,
				walletAddress,
				isSimulation,
				entityId,
				recommendationId,
				initialPrice: price,
				balance: "0",
				status: "OPEN",
				amount: amount.toString(),
				createdAt: new Date(),
			};

			// Store in memory
			await this.storePosition(position);

			return position;
		} catch (error) {
			logger.error("Error creating position:", error);
			return null;
		}
	}

	/**
	 * Record a transaction
	 */
	private async recordTransaction(
		positionId: UUID,
		tokenAddress: string,
		type: TransactionType,
		amount: bigint,
		price: number,
		isSimulation: boolean,
	): Promise<boolean> {
		logger.debug(
			"recording transaction",
			positionId,
			tokenAddress,
			type,
			amount,
			price,
			isSimulation,
		);
		try {
			const transaction: Transaction = {
				id: uuidv4() as UUID,
				positionId,
				chain: this.tradingConfig.defaultChain,
				tokenAddress,
				type,
				amount: amount.toString(),
				price: price.toString(),
				isSimulation,
				timestamp: new Date(),
			};

			// Store in memory
			await this.storeTransaction(transaction);

			// Emit event
			// this.emitEvent({ type: 'transaction_added', transaction });

			return true;
		} catch (error) {
			logger.error("Error recording transaction:", error);
			return false;
		}
	}

	/**
	 * Get all positions for an entity
	 */
	async getPositionsByRecommender(entityId: UUID): Promise<Position[]> {
		logger.debug("getting positions by recommender", entityId);
		try {
			const recommendations =
				await this.getRecommendationsByRecommender(entityId);
			const positions: Position[] = [];

			for (const recommendation of recommendations) {
				const positionMatches = await this.getPositionsByToken(
					recommendation.tokenAddress,
				);

				// Filter for positions associated with this entity
				const entityPositions = positionMatches.filter(
					(position) => position.entityId === entityId,
				);

				positions.push(...entityPositions);
			}

			return positions;
		} catch (error) {
			logger.error("Error getting positions by entity:", error);
			return [];
		}
	}

	/**
	 * Get all positions for a token
	 */
	private async getPositionsByToken(tokenAddress: string): Promise<Position[]> {
		logger.debug("getting positions by token", tokenAddress);
		try {
			// This is a simplified implementation
			// In a real-world scenario, you'd query the database
			const positions = await this.getOpenPositionsWithBalance();
			return positions.filter(
				(position) => position.tokenAddress === tokenAddress,
			);
		} catch (error) {
			logger.error("Error getting positions by token:", error);
			return [];
		}
	}

	/**
	 * Get all transactions for a position
	 */
	async getTransactionsByPosition(positionId: UUID): Promise<Transaction[]> {
		logger.debug("getting transactions by position", positionId);
		try {
			// Search for transactions with this position ID
			const query = `transactions for position ${positionId}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "transactions",
				embedding,
				match_threshold: 0.7,
				count: 20,
			});

			const transactions: Transaction[] = [];

			for (const memory of memories) {
				if (
					memory.content.transaction &&
					(memory.content.transaction as Transaction).positionId === positionId
				) {
					transactions.push(memory.content.transaction as Transaction);
				}
			}

			return transactions;
		} catch (error) {
			logger.error("Error getting transactions by position:", error);
			return [];
		}
	}

	/**
	 * Get all transactions for a token
	 */
	async getTransactionsByToken(tokenAddress: string): Promise<Transaction[]> {
		logger.debug("getting transactions by token", tokenAddress);
		try {
			// Search for transactions with this token address
			const query = `transactions for token ${tokenAddress}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "transactions",
				embedding,
				match_threshold: 0.7,
				count: 50,
			});

			const transactions: Transaction[] = [];

			for (const memory of memories) {
				if (
					memory.content.transaction &&
					(memory.content.transaction as Transaction).tokenAddress ===
						tokenAddress
				) {
					transactions.push(memory.content.transaction as Transaction);
				}
			}

			return transactions;
		} catch (error) {
			logger.error("Error getting transactions by token:", error);
			return [];
		}
	}

	/**
	 * Get a position by ID
	 */
	async getPosition(positionId: UUID): Promise<Position | null> {
		logger.debug("getting position", positionId);
		try {
			// Check cache first
			const cacheKey = `position:${positionId}`;
			const cachedPosition = await this.runtime.getCache<Position>(cacheKey);

			if (cachedPosition) {
				return cachedPosition;
			}

			// Search for position in memory
			const query = `position with ID ${positionId}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "positions",
				embedding,
				match_threshold: 0.7,
				count: 1,
			});

			if (memories.length > 0 && memories[0].content.position) {
				const position = memories[0].content.position as Position;

				// Cache the position
				await this.runtime.setCache<Position>(cacheKey, position); // Cache for 5 minutes

				return position;
			}

			return null;
		} catch (error) {
			logger.error("Error getting position:", error);
			return null;
		}
	}

	/**
	 * Get all recommendations by a entity
	 */
	async getRecommendationsByRecommender(
		entityId: UUID,
	): Promise<TokenRecommendation[]> {
		logger.debug("getting recommendations by recommender", entityId);
		try {
			// Search for recommendations by this entity
			const query = `recommendations by entity ${entityId}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "recommendations",
				embedding,
				match_threshold: 0.7,
				count: 50,
			});

			const recommendations: TokenRecommendation[] = [];

			for (const memory of memories) {
				const meta = memory.metadata as Record<string, unknown> | undefined;
				if (
					meta?.recommendation &&
					(meta.recommendation as TokenRecommendation).entityId === entityId
				) {
					recommendations.push(meta.recommendation as TokenRecommendation);
				}
			}

			return recommendations;
		} catch (error) {
			logger.error("Error getting recommendations by entity:", error);
			return [];
		}
	}

	/**
	 * Close a position and update metrics
	 */
	async closePosition(positionId: UUID): Promise<boolean> {
		logger.debug("closing position", positionId);
		try {
			const position = await this.getPosition(positionId);
			if (!position) {
				logger.error(`Position ${positionId} not found`);
				return false;
			}

			// Update position status
			position.status = "CLOSED";
			position.closedAt = new Date();

			// Calculate final metrics
			const transactions = await this.getTransactionsByPosition(positionId);
			const performance = await this.calculatePositionPerformance(
				position,
				transactions,
			);

			// Update entity metrics
			await this.updateRecommenderMetrics(position.entityId, performance);

			// Store in memory
			await this.storePosition(position);

			// Emit event
			// this.emitEvent({ type: 'position_closed', position });

			return true;
		} catch (error) {
			logger.error(`Failed to close position ${positionId}:`, error);
			return false;
		}
	}

	/**
	 * Calculate position performance
	 */
	private async calculatePositionPerformance(
		position: Position,
		transactions: Transaction[],
	): Promise<number> {
		logger.debug("calculating position performance", position, transactions);
		if (!transactions.length) return 0;

		const buyTxs = transactions.filter((t) => t.type === TransactionType.BUY);
		const sellTxs = transactions.filter((t) => t.type === TransactionType.SELL);

		const totalBuyAmount = buyTxs.reduce(
			(sum, tx) => sum + BigInt(tx.amount),
			0n,
		);
		const _totalSellAmount = sellTxs.reduce(
			(sum, tx) => sum + BigInt(tx.amount),
			0n,
		);

		position.amount = totalBuyAmount.toString();

		const avgBuyPrice =
			buyTxs.reduce((sum, tx) => sum + Number(tx.price), 0) / buyTxs.length;
		const avgSellPrice = sellTxs.length
			? sellTxs.reduce((sum, tx) => sum + Number(tx.price), 0) / sellTxs.length
			: await this.getCurrentPrice(position.chain, position.tokenAddress);

		position.currentPrice = avgSellPrice.toString();

		return ((avgSellPrice - avgBuyPrice) / avgBuyPrice) * 100;
	}

	/**
	 * Store token performance data
	 */
	private async storeTokenPerformance(token: TokenPerformance): Promise<void> {
		logger.debug("storing token performance", token);
		try {
			// Create memory object
			const memory: Memory = {
				id: uuidv4() as UUID,
				entityId: this.runtime.agentId,
				roomId: "global" as UUID,
				content: {
					text: `Token performance data for ${token.symbol || token.address} on ${token.chain}`,
					token,
				},
				createdAt: Date.now(),
			};

			// Add embedding to memory
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				memory.content.text,
			);
			const memoryWithEmbedding = { ...memory, embedding };

			// Store in memory manager
			await this.runtime.createMemory(memoryWithEmbedding, "tokens", true);

			// Also cache for quick access
			const cacheKey = `token:${token.chain}:${token.address}:performance`;
			await this.runtime.setCache<TokenPerformance>(cacheKey, token); // Cache for 5 minutes
		} catch (error) {
			logger.error(
				`Error storing token performance for ${token.address}:`,
				error,
			);
		}
	}

	/**
	 * Store position data
	 */
	private async storePosition(position: Position): Promise<void> {
		logger.debug("storing position", position);
		try {
			// Create memory object
			const memory: Memory = {
				id: uuidv4() as UUID,
				entityId: this.runtime.agentId,
				roomId: "global" as UUID,
				content: {
					text: `Position data for token ${position.tokenAddress} by entity ${position.entityId}`,
					position,
				},
				createdAt: Date.now(),
			};

			// Add embedding to memory
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				memory.content.text,
			);
			const memoryWithEmbedding = { ...memory, embedding };

			// Store in memory manager
			await this.runtime.createMemory(memoryWithEmbedding, "positions", true);

			// Also cache for quick access
			const cacheKey = `position:${position.id}`;
			await this.runtime.setCache<Position>(cacheKey, position);
		} catch (error) {
			logger.error(
				`Error storing position for ${position.tokenAddress}:`,
				error,
			);
		}
	}

	/**
	 * Store transaction data
	 */
	private async storeTransaction(transaction: Transaction): Promise<void> {
		logger.debug("storing transaction", transaction);
		try {
			// Create memory object
			const memory: Memory = {
				id: uuidv4() as UUID,
				entityId: this.runtime.agentId,
				roomId: "global" as UUID,
				content: {
					text: `Transaction data for position ${transaction.positionId} token ${transaction.tokenAddress} ${transaction.type}`,
					transaction,
				},
				createdAt: Date.now(),
			};

			// Add embedding to memory
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				memory.content.text,
			);
			const memoryWithEmbedding = { ...memory, embedding };

			// Store in memory manager
			await this.runtime.createMemory(
				memoryWithEmbedding,
				"transactions",
				true,
			);

			// Also cache transaction list for position
			const cacheKey = `position:${transaction.positionId}:transactions`;
			const cachedTxs = await this.runtime.getCache<Transaction[]>(cacheKey);

			if (cachedTxs) {
				const txs = cachedTxs as Transaction[];
				txs.push(transaction);
				await this.runtime.setCache<Transaction[]>(cacheKey, txs); // Cache for 5 minutes
			} else {
				await this.runtime.setCache<Transaction[]>(cacheKey, [transaction]); // Cache for 5 minutes
			}
		} catch (error) {
			logger.error(
				`Error storing transaction for position ${transaction.positionId}:`,
				error,
			);
		}
	}

	/**
	 * Store token recommendation data
	 */
	private async storeTokenRecommendation(
		recommendation: TokenRecommendation,
	): Promise<void> {
		logger.debug("storing token recommendation", recommendation);
		try {
			// Create memory object
			const memory: Memory = {
				id: uuidv4() as UUID,
				entityId: this.runtime.agentId,
				roomId: "global" as UUID,
				content: {
					text: `Token recommendation for ${recommendation.tokenAddress} by entity ${recommendation.entityId}`,
					recommendation,
				},
				createdAt: Date.now(),
			};

			// Add embedding to memory
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				memory.content.text,
			);
			const memoryWithEmbedding = { ...memory, embedding };

			// Store in memory manager
			await this.runtime.createMemory(
				memoryWithEmbedding,
				"recommendations",
				true,
			);

			// Also cache for quick access
			const cacheKey = `recommendation:${recommendation.id}`;
			await this.runtime.setCache<TokenRecommendation>(
				cacheKey,
				recommendation,
			); // Cache for 5 minutes
		} catch (error) {
			logger.error(
				`Error storing recommendation for ${recommendation.tokenAddress}:`,
				error,
			);
		}
	}

	/**
	 * Store entity metrics
	 */
	private async storeRecommenderMetrics(
		metrics: RecommenderMetrics,
	): Promise<void> {
		logger.debug("storing recommender metrics", metrics);
		try {
			// Create memory object
			const memory: Memory = {
				id: uuidv4() as UUID,
				entityId: this.runtime.agentId,
				roomId: "global" as UUID,
				content: {
					text: `Recommender metrics for ${metrics.entityId}`,
					metrics,
				},
				createdAt: Date.now(),
			};

			// Add embedding to memory
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				memory.content.text,
			);
			const memoryWithEmbedding = { ...memory, embedding };

			// Store in memory manager
			await this.runtime.createMemory(
				memoryWithEmbedding,
				"recommender_metrics",
				true,
			);

			// Also cache for quick access
			const cacheKey = `entity:${metrics.entityId}:metrics`;
			await this.runtime.setCache<RecommenderMetrics>(cacheKey, metrics); // Cache for 5 minutes
		} catch (error) {
			logger.error(
				`Error storing entity metrics for ${metrics.entityId}:`,
				error,
			);
		}
	}

	/**
	 * Store entity metrics history
	 */
	private async storeRecommenderMetricsHistory(
		history: RecommenderMetricsHistory,
	): Promise<void> {
		logger.debug("storing recommender metrics history", history);
		try {
			// Create memory object
			const memory: Memory = {
				id: uuidv4() as UUID,
				entityId: this.runtime.agentId,
				roomId: "global" as UUID,
				content: {
					text: `Recommender metrics history for ${history.entityId}`,
					history,
				},
				createdAt: Date.now(),
			};

			// Add embedding to memory
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				memory.content.text,
			);
			const memoryWithEmbedding = { ...memory, embedding };

			// Store in memory manager
			await this.runtime.createMemory(
				memoryWithEmbedding,
				"recommender_metrics_history",
				true,
			);

			// Also update history list in cache
			const cacheKey = `entity:${history.entityId}:history`;
			const cachedHistory =
				await this.runtime.getCache<RecommenderMetricsHistory[]>(cacheKey);

			if (cachedHistory) {
				const histories = cachedHistory as RecommenderMetricsHistory[];
				histories.push(history);
				// Keep only the last 10 entries
				const recentHistories = histories
					.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
					.slice(0, 10);
				await this.runtime.setCache<RecommenderMetricsHistory[]>(
					cacheKey,
					recentHistories,
				); // Cache for 1 hour
			} else {
				await this.runtime.setCache<RecommenderMetricsHistory[]>(cacheKey, [
					history,
				]); // Cache for 1 hour
			}
		} catch (error) {
			logger.error(
				`Error storing entity metrics history for ${history.entityId}:`,
				error,
			);
		}
	}

	/**
	 * Get entity metrics
	 */
	async getRecommenderMetrics(
		entityId: UUID,
	): Promise<RecommenderMetrics | null> {
		logger.debug("getting recommender metrics", entityId);
		try {
			// Check cache first
			const cacheKey = `entity:${entityId}:metrics`;
			const cachedMetrics =
				await this.runtime.getCache<RecommenderMetrics>(cacheKey);

			if (cachedMetrics) {
				return cachedMetrics as RecommenderMetrics;
			}

			// Search for metrics in memory
			const query = `entity metrics for entity ${entityId}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "recommender_metrics",
				embedding,
				match_threshold: 0.7,
				count: 1,
			});

			if (memories.length > 0 && memories[0].content.metrics) {
				const metrics = memories[0].content.metrics as RecommenderMetrics;

				// Cache the metrics
				await this.runtime.setCache<RecommenderMetrics>(cacheKey, metrics); // Cache for 5 minutes

				return metrics;
			}

			return null;
		} catch (error) {
			logger.error(`Error getting entity metrics for ${entityId}:`, error);
			return null;
		}
	}

	/**
	 * Get entity metrics history
	 */
	async getRecommenderMetricsHistory(
		entityId: UUID,
	): Promise<RecommenderMetricsHistory[]> {
		logger.debug("getting recommender metrics history", entityId);
		try {
			// Check cache first
			const cacheKey = `entity:${entityId}:history`;
			const cachedHistory =
				await this.runtime.getCache<RecommenderMetricsHistory[]>(cacheKey);

			if (cachedHistory) {
				return cachedHistory as RecommenderMetricsHistory[];
			}

			// Search for history in memory
			const query = `entity metrics history for entity ${entityId}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "recommender_metrics_history",
				embedding,
				match_threshold: 0.7,
				count: 10,
			});

			const historyEntries: RecommenderMetricsHistory[] = [];

			for (const memory of memories) {
				if (
					memory.content.history &&
					(memory.content.history as RecommenderMetricsHistory).entityId ===
						entityId
				) {
					historyEntries.push(
						memory.content.history as RecommenderMetricsHistory,
					);
				}
			}

			// Sort by timestamp, newest first
			const sortedEntries = historyEntries.sort(
				(a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
			);

			// Cache the history
			await this.runtime.setCache<RecommenderMetricsHistory[]>(
				cacheKey,
				sortedEntries,
			); // Cache for 1 hour

			return sortedEntries;
		} catch (error) {
			logger.error(
				`Error getting entity metrics history for ${entityId}:`,
				error,
			);
			return [];
		}
	}

	/**
	 * Initialize entity metrics
	 */
	async initializeRecommenderMetrics(
		entityId: UUID,
		platform: string,
	): Promise<void> {
		logger.debug("initializing recommender metrics", entityId, platform);
		try {
			const initialMetrics: RecommenderMetrics = {
				entityId,
				platform,
				totalRecommendations: 0,
				successfulRecs: 0,
				consistencyScore: 50,
				trustScore: 50,
				failedTrades: 0,
				totalProfit: 0,
				avgTokenPerformance: 0,
				lastUpdated: new Date(),
				createdAt: new Date(),
			};

			await this.storeRecommenderMetrics(initialMetrics);

			// Also create initial history entry
			const historyEntry: RecommenderMetricsHistory = {
				entityId,
				metrics: initialMetrics,
				timestamp: new Date(),
			};

			await this.storeRecommenderMetricsHistory(historyEntry);
		} catch (error) {
			logger.error(`Error initializing entity metrics for ${entityId}:`, error);
		}
	}

	/**
	 * Get token performance
	 */
	async getTokenPerformance(
		tokenAddress: string,
		chain: string,
	): Promise<TokenPerformance | null> {
		logger.debug("getting token performance", tokenAddress, chain);
		try {
			// Check cache first
			const cacheKey = `token:${chain}:${tokenAddress}:performance`;
			const cachedToken =
				await this.runtime.getCache<TokenPerformance>(cacheKey);

			if (cachedToken) {
				return cachedToken as TokenPerformance;
			}

			// Search for token in memory
			const query = `token performance for ${tokenAddress}`;
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "tokens",
				embedding,
				match_threshold: 0.7,
				count: 1,
			});

			if (memories.length > 0 && memories[0].content.token) {
				const token = memories[0].content.token as TokenPerformance;

				// Cache the token
				await this.runtime.setCache<TokenPerformance>(cacheKey, token); // Cache for 5 minutes

				return token;
			}

			return null;
		} catch (error) {
			logger.error(
				`Error getting token performance for ${tokenAddress}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Get open positions with balance
	 */
	async getOpenPositionsWithBalance(): Promise<PositionWithBalance[]> {
		logger.debug("getting open positions with balance");
		try {
			// Check cache first
			const cacheKey = "positions:open:with-balance";
			const cachedPositions =
				await this.runtime.getCache<PositionWithBalance[]>(cacheKey);

			if (cachedPositions) {
				return cachedPositions as PositionWithBalance[];
			}

			// Search for open positions in memory
			const query = "open positions with balance";
			const embedding = await this.runtime.useModel(
				ModelType.TEXT_EMBEDDING,
				query,
			);

			const memories = await this.runtime.searchMemories({
				tableName: "positions",
				embedding,
				match_threshold: 0.7,
				count: 50,
			});

			const positions: PositionWithBalance[] = [];

			for (const memory of memories) {
				if (memory.content.position) {
					const position = memory.content.position as Position;

					// Check if position is open
					if (position.status === "OPEN") {
						// Convert to PositionWithBalance
						positions.push({
							...position,
							balance: BigInt(position.balance || "0") as never,
						});
					}
				}
			}

			// Cache the positions
			await this.runtime.setCache<PositionWithBalance[]>(cacheKey, positions); // Cache for 5 minutes

			return positions;
		} catch (error) {
			logger.error("Error getting open positions with balance:", error);
			return [];
		}
	}

	/**
	 * Get positions transactions
	 */
	async getPositionsTransactions(positionIds: UUID[]): Promise<Transaction[]> {
		logger.debug("getting positions transactions", positionIds);
		try {
			const allTransactions: Transaction[] = [];

			for (const positionId of positionIds) {
				const transactions = await this.getTransactionsByPosition(positionId);
				allTransactions.push(...transactions);
			}

			return allTransactions;
		} catch (error) {
			logger.error("Error getting transactions for positions:", error);
			return [];
		}
	}

	/**
	 * Get formatted portfolio report
	 */
	async getFormattedPortfolioReport(entityId?: UUID): Promise<string> {
		logger.debug("getting formatted portfolio report", entityId);
		try {
			// Get positions
			const positions = await this.getOpenPositionsWithBalance();

			// Filter by entity if provided
			const filteredPositions = entityId
				? positions.filter((p) => p.entityId === entityId)
				: positions;

			if (filteredPositions.length === 0) {
				return "No open positions found.";
			}

			// Get tokens and transactions
			const tokens: TokenPerformance[] = [];
			const tokenSet = new Set<string>();

			for (const position of filteredPositions) {
				if (tokenSet.has(`${position.chain}:${position.tokenAddress}`))
					continue;

				const token = await this.getTokenPerformance(
					position.tokenAddress,
					position.chain,
				);
				if (token) tokens.push(token);

				tokenSet.add(`${position.chain}:${position.tokenAddress}`);
			}

			// Get transactions
			const transactions = await this.getPositionsTransactions(
				filteredPositions.map((p) => p.id),
			);

			// Format the report
			const report = formatFullReport(tokens, filteredPositions, transactions);

			return `
Portfolio Summary:
Total Current Value: ${report.totalCurrentValue}
Total Realized P&L: ${report.totalRealizedPnL}
Total Unrealized P&L: ${report.totalUnrealizedPnL}
Total P&L: ${report.totalPnL}

Positions:
${report.positionReports.join("\n")}

Tokens:
${report.tokenReports.join("\n")}
            `.trim();
		} catch (error) {
			logger.error("Error generating portfolio report:", error);
			return "Error generating portfolio report.";
		}
	}

	async initialize(runtime: IAgentRuntime): Promise<void> {
		logger.info("[CommunityInvestorService] Initializing...");
		this.apiKeys.birdeye = runtime.getSetting("BIRDEYE_API_KEY") as
			| string
			| undefined;
		this.apiKeys.moralis = runtime.getSetting("MORALIS_API_KEY") as
			| string
			| undefined;
		// Load the user registry
		await this.loadUserRegistry();
		logger.info("[CommunityInvestorService] Initialized.");
	}

	/**
	 * Fetches token data from an external API.
	 * Uses Birdeye and DexScreener for real market data.
	 */
	async getTokenAPIData(
		address: string,
		chain: SupportedChain,
	): Promise<TokenAPIData | null> {
		logger.debug(
			`[CommunityInvestorService] Fetching token API data for ${address} on ${chain}`,
		);

		try {
			let tokenData: TokenAPIData = {};

			if (chain === SupportedChain.SOLANA) {
				// Fetch from Birdeye for Solana tokens
				try {
					const [tokenOverview, price, security, tradeData, dexScreenerData] =
						await Promise.all([
							this.birdeyeClient.fetchTokenOverview(address, {
								chain: "solana",
								expires: "5m",
							}),
							this.birdeyeClient.fetchPrice(address, {
								chain: "solana",
								expires: "1m",
							}),
							this.birdeyeClient.fetchTokenSecurity(address, {
								chain: "solana",
								expires: "10m",
							}),
							this.birdeyeClient.fetchTokenTradeData(address, {
								chain: "solana",
								expires: "5m",
							}),
							this.dexscreenerClient.search(address, { expires: "5m" }),
						]);

					const dexPair = dexScreenerData.pairs?.[0];

					tokenData = {
						name: tokenOverview.name || dexPair?.baseToken?.name,
						symbol: tokenOverview.symbol || dexPair?.baseToken?.symbol,
						currentPrice: price || parseFloat(dexPair?.priceUsd || "0"),
						liquidity: dexPair?.liquidity?.usd || 0,
						marketCap: dexPair?.marketCap || tradeData.market || 0,
						isKnownScam: false, // Would need additional scam detection logic
					};

					// Calculate ATH and ATL from recent trade data if available
					if (tradeData) {
						const recent24hPrices = [
							tradeData.price,
							tradeData.history_24h_price,
							tradeData.history_12h_price,
							tradeData.history_8h_price,
							tradeData.history_6h_price,
							tradeData.history_4h_price,
							tradeData.history_2h_price,
							tradeData.history_1h_price,
							tradeData.history_30m_price,
						].filter((p) => p != null && p > 0);

						if (recent24hPrices.length > 0) {
							tokenData.ath = Math.max(...recent24hPrices);
							tokenData.atl = Math.min(...recent24hPrices);
						}

						// Create simplified price history from trade data
						const now = Date.now();
						tokenData.priceHistory = [
							{
								timestamp: now - 24 * 60 * 60 * 1000,
								price: tradeData.history_24h_price || tradeData.price,
							},
							{
								timestamp: now - 12 * 60 * 60 * 1000,
								price: tradeData.history_12h_price || tradeData.price,
							},
							{
								timestamp: now - 8 * 60 * 60 * 1000,
								price: tradeData.history_8h_price || tradeData.price,
							},
							{
								timestamp: now - 6 * 60 * 60 * 1000,
								price: tradeData.history_6h_price || tradeData.price,
							},
							{
								timestamp: now - 4 * 60 * 60 * 1000,
								price: tradeData.history_4h_price || tradeData.price,
							},
							{
								timestamp: now - 2 * 60 * 60 * 1000,
								price: tradeData.history_2h_price || tradeData.price,
							},
							{
								timestamp: now - 1 * 60 * 60 * 1000,
								price: tradeData.history_1h_price || tradeData.price,
							},
							{
								timestamp: now - 30 * 60 * 1000,
								price: tradeData.history_30m_price || tradeData.price,
							},
							{ timestamp: now, price: tradeData.price },
						].filter((p) => p.price != null && p.price > 0);

						// Simple scam detection based on trade data patterns
						const hasRugPullPattern =
							tradeData.price_change_24h_percent < -90 || // 90% drop in 24h
							(tradeData.volume_24h_usd < 1000 &&
								tokenData.marketCap &&
								tokenData.marketCap > 100000) || // Low volume but high market cap
							(security && security.top10HolderPercent > 95); // Top 10 holders own >95%

						tokenData.isKnownScam = hasRugPullPattern;
					}
				} catch (error) {
					logger.warn(
						`[CommunityInvestorService] Error fetching Solana token data for ${address}:`,
						error,
					);

					// Fallback to DexScreener only
					try {
						const dexScreenerData = await this.dexscreenerClient.search(
							address,
							{ expires: "5m" },
						);
						const dexPair = dexScreenerData.pairs?.[0];

						if (dexPair) {
							tokenData = {
								name: dexPair.baseToken.name,
								symbol: dexPair.baseToken.symbol,
								currentPrice: parseFloat(dexPair.priceUsd || "0"),
								liquidity: dexPair.liquidity?.usd || 0,
								marketCap: dexPair.marketCap || 0,
								isKnownScam: false, // Dexscreener doesn't directly provide this
							};
							// No extensive history from this fallback, but it's better than nothing
						} else {
							logger.debug(
								`[CommunityInvestorService] DexScreener found no pair for ${address} after Birdeye failure.`,
							);
							// Explicitly return null if DexScreener also fails for Solana
							return null;
						}
					} catch (fallbackError) {
						logger.error(
							`[CommunityInvestorService] Fallback DexScreener search also failed for ${address}:`,
							fallbackError,
						);
						return null; // Return null on fallback failure too
					}
				}
			} else if (
				chain === SupportedChain.ETHEREUM ||
				chain === SupportedChain.BASE
			) {
				// For Ethereum and Base, use DexScreener as primary source
				try {
					const dexScreenerData = await this.dexscreenerClient.search(address, {
						expires: "5m",
					});
					const chainFilter =
						chain === SupportedChain.ETHEREUM ? "ethereum" : "base";
					const dexPair = dexScreenerData.pairs?.find(
						(pair) => pair.chainId.toLowerCase() === chainFilter,
					);

					if (dexPair) {
						tokenData = {
							name: dexPair.baseToken.name,
							symbol: dexPair.baseToken.symbol,
							currentPrice: parseFloat(dexPair.priceUsd || "0"),
							liquidity: dexPair.liquidity?.usd || 0,
							marketCap: dexPair.marketCap || 0,
							isKnownScam: false,
						};

						// Extract price history from DexScreener price changes
						const now = Date.now();
						const currentPrice = parseFloat(dexPair.priceUsd || "0");

						tokenData.priceHistory = [
							{
								timestamp: now - 24 * 60 * 60 * 1000,
								price:
									currentPrice / (1 + (dexPair.priceChange?.h24 || 0) / 100),
							},
							{
								timestamp: now - 6 * 60 * 60 * 1000,
								price:
									currentPrice / (1 + (dexPair.priceChange?.h6 || 0) / 100),
							},
							{
								timestamp: now - 1 * 60 * 60 * 1000,
								price:
									currentPrice / (1 + (dexPair.priceChange?.h1 || 0) / 100),
							},
							{
								timestamp: now - 5 * 60 * 1000,
								price:
									currentPrice / (1 + (dexPair.priceChange?.m5 || 0) / 100),
							},
							{ timestamp: now, price: currentPrice },
						].filter((p) => p.price > 0);

						if (tokenData.priceHistory.length > 0) {
							tokenData.ath = Math.max(
								...tokenData.priceHistory.map((p) => p.price),
							);
							tokenData.atl = Math.min(
								...tokenData.priceHistory.map((p) => p.price),
							);
						}

						// Simple scam detection for Ethereum/Base tokens
						const hasRugPullPattern =
							(dexPair.priceChange?.h24 || 0) < -90 || // 90% drop in 24h
							((dexPair.volume?.h24 || 0) < 1000 &&
								(dexPair.marketCap || 0) > 100000); // Low volume but high market cap

						tokenData.isKnownScam = hasRugPullPattern;
					}
				} catch (error) {
					logger.error(
						`[CommunityInvestorService] Error fetching ${chain} token data for ${address}:`,
						error,
					);
					return null;
				}
			} else {
				logger.warn(`[CommunityInvestorService] Unsupported chain: ${chain}`);
				return null;
			}

			// This check is now effectively handled by returning null in the SOLANA block if all sources fail.
			// if (chain === SupportedChain.SOLANA && Object.keys(tokenData).length === 0) {
			//   logger.debug(`[CommunityInvestorService] TokenData for SOLANA token ${address} is empty after all attempts, returning null.`);
			//   return null;
			// }

			// Set defaults for missing values if tokenData was populated by non-SOLANA chain logic or partially by SOLANA.
			if (Object.keys(tokenData).length > 0) {
				// Ensure tokenData is not empty before defaulting
				if (!tokenData.ath && tokenData.currentPrice) {
					tokenData.ath = tokenData.currentPrice * 1.1; // Assume current price is close to ATH if unknown
				}
				if (!tokenData.atl && tokenData.currentPrice) {
					tokenData.atl = tokenData.currentPrice * 0.9; // Assume current price is close to ATL if unknown
				}
				logger.debug(
					`[CommunityInvestorService] Successfully fetched token data for ${tokenData.symbol || address} (${address})`,
				);
				return tokenData;
			} else if (chain !== SupportedChain.SOLANA) {
				// If not SOLANA and tokenData is still empty (e.g. ETH/BASE failed)
				logger.warn(
					`[CommunityInvestorService] Failed to fetch token data for ${address} on ${chain} after all attempts.`,
				);
				return null;
			}
			// If it's SOLANA and tokenData is empty, we would have returned null already.
			// For other chains, if tokenData is empty, this means their primary fetch failed.
			// This final return null should ideally not be hit if all paths correctly return null on failure.
			return null;
		} catch (error) {
			logger.error(
				`[CommunityInvestorService] Unexpected error fetching token API data for ${address}:`,
				error,
			);
			return null;
		}
	}

	async isLikelyScamOrRug(
		tokenData: TokenAPIData,
		recommendationTimestamp: number,
	): Promise<boolean> {
		// Check if already flagged as scam
		if (tokenData.isKnownScam) {
			logger.warn(
				`[CommunityInvestorService] Token ${tokenData.symbol} already flagged as known scam`,
			);
			return true;
		}

		const warnings: string[] = [];
		let riskScore = 0;

		// 1. Price drop analysis
		const pricesPostRecommendation =
			tokenData.priceHistory?.filter(
				(p) => p.timestamp > recommendationTimestamp,
			) || [];

		if (pricesPostRecommendation.length > 1) {
			const peakPricePostRec = Math.max(
				...pricesPostRecommendation.map((p) => p.price),
			);
			const lastKnownPricePostRec =
				pricesPostRecommendation[pricesPostRecommendation.length - 1].price;
			const currentPrice = tokenData.currentPrice || 0;

			// Severe price drop from peak (>90%)
			if (
				peakPricePostRec > 0 &&
				lastKnownPricePostRec < peakPricePostRec * 0.1 &&
				currentPrice < peakPricePostRec * 0.1
			) {
				warnings.push(
					`Severe price drop: >90% from peak ($${peakPricePostRec.toFixed(6)} to $${currentPrice.toFixed(6)})`,
				);
				riskScore += 40;
			}
			// Major price drop (>70%)
			else if (
				peakPricePostRec > 0 &&
				lastKnownPricePostRec < peakPricePostRec * 0.3 &&
				currentPrice < peakPricePostRec * 0.3
			) {
				warnings.push(
					`Major price drop: >70% from peak ($${peakPricePostRec.toFixed(6)} to $${currentPrice.toFixed(6)})`,
				);
				riskScore += 25;
			}
		}

		// 2. Liquidity-to-MarketCap ratio analysis
		const marketCap = tokenData.marketCap || 0;
		const liquidity = tokenData.liquidity || 0;

		if (marketCap > 10000 && liquidity > 0) {
			const liquidityRatio = liquidity / marketCap;

			// Extremely low liquidity ratio (<0.5%)
			if (liquidityRatio < 0.005) {
				warnings.push(
					`Extremely low liquidity ratio: ${(liquidityRatio * 100).toFixed(2)}% (Liquidity: $${liquidity.toFixed(0)}, MC: $${marketCap.toFixed(0)})`,
				);
				riskScore += 30;
			}
			// Very low liquidity ratio (<1%)
			else if (liquidityRatio < 0.01) {
				warnings.push(
					`Very low liquidity ratio: ${(liquidityRatio * 100).toFixed(2)}%`,
				);
				riskScore += 20;
			}
			// Low liquidity ratio (<2%)
			else if (liquidityRatio < 0.02) {
				warnings.push(
					`Low liquidity ratio: ${(liquidityRatio * 100).toFixed(2)}%`,
				);
				riskScore += 10;
			}
		}

		// 3. Absolute liquidity thresholds
		if (liquidity > 0) {
			if (liquidity < 500) {
				warnings.push(`Critical liquidity: $${liquidity.toFixed(0)}`);
				riskScore += 35;
			} else if (liquidity < 2000) {
				warnings.push(`Very low liquidity: $${liquidity.toFixed(0)}`);
				riskScore += 20;
			} else if (liquidity < 5000) {
				warnings.push(`Low liquidity: $${liquidity.toFixed(0)}`);
				riskScore += 10;
			}
		} else {
			warnings.push("No liquidity data available");
			riskScore += 15;
		}

		// 4. Market cap sanity check
		if (marketCap > 0 && tokenData.currentPrice && tokenData.currentPrice > 0) {
			// If market cap seems unrealistically high compared to liquidity
			if (marketCap > 1000000 && liquidity < 10000) {
				warnings.push(
					`Suspicious MC/Liquidity: MC $${marketCap.toFixed(0)} vs Liquidity $${liquidity.toFixed(0)}`,
				);
				riskScore += 25;
			}
		}

		// 5. Price movement patterns (volatility spikes)
		if (tokenData.priceHistory && tokenData.priceHistory.length >= 3) {
			const prices = tokenData.priceHistory.map((p) => p.price);
			const priceChanges = [];

			for (let i = 1; i < prices.length; i++) {
				if (prices[i - 1] > 0) {
					const change = ((prices[i] - prices[i - 1]) / prices[i - 1]) * 100;
					priceChanges.push(Math.abs(change));
				}
			}

			if (priceChanges.length > 0) {
				const avgVolatility =
					priceChanges.reduce((sum, change) => sum + change, 0) /
					priceChanges.length;
				const maxChange = Math.max(...priceChanges);

				// Extreme volatility patterns
				if (maxChange > 200) {
					// >200% price change in one period
					warnings.push(
						`Extreme volatility: ${maxChange.toFixed(1)}% max change`,
					);
					riskScore += 20;
				} else if (avgVolatility > 50) {
					// Average >50% volatility
					warnings.push(
						`High volatility: ${avgVolatility.toFixed(1)}% average change`,
					);
					riskScore += 10;
				}
			}
		}

		// 6. Age-based risk (newer tokens are riskier)
		const tokenAge = Date.now() - recommendationTimestamp;
		const ageInHours = tokenAge / (1000 * 60 * 60);

		if (ageInHours < 24) {
			warnings.push(`Very new token: ${ageInHours.toFixed(1)} hours old`);
			riskScore += 15;
		} else if (ageInHours < 72) {
			warnings.push(`New token: ${ageInHours.toFixed(1)} hours old`);
			riskScore += 8;
		}

		// Determine if it's likely a scam/rug based on risk score
		const isLikelyRug = riskScore >= 50; // Threshold for rug pull classification

		if (warnings.length > 0) {
			const logLevel = isLikelyRug ? "warn" : "debug";
			logger[logLevel](
				`[CommunityInvestorService] Token ${tokenData.symbol} risk analysis (Score: ${riskScore}/100): ${warnings.join("; ")}`,
			);
		}

		if (isLikelyRug) {
			logger.warn(
				`[CommunityInvestorService] Token ${tokenData.symbol} classified as likely scam/rug (Risk Score: ${riskScore}/100)`,
			);
		}

		return isLikelyRug;
	}

	async evaluateRecommendationPerformance(
		recommendation: Recommendation,
		tokenData: TokenAPIData,
	): Promise<RecommendationMetric> {
		logger.debug(
			`[CommunityInvestorService] Evaluating performance for rec ID: ${recommendation.id}`,
		);
		const metric: RecommendationMetric = {
			evaluationTimestamp: Date.now(),
			isScamOrRug: await this.isLikelyScamOrRug(
				tokenData,
				recommendation.timestamp,
			),
			notes: "",
		};
		const priceAtRec =
			recommendation.priceAtRecommendation ||
			tokenData.priceHistory?.find(
				(p) => p.timestamp >= recommendation.timestamp,
			)?.price ||
			tokenData.currentPrice ||
			0;
		const pricesAfterRec =
			tokenData.priceHistory?.filter(
				(p) => p.timestamp > recommendation.timestamp,
			) || [];

		if (metric.isScamOrRug) {
			if (recommendation.recommendationType === "BUY") {
				metric.potentialProfitPercent = -99;
				metric.notes =
					"Token identified as likely scam/rug pull after BUY recommendation.";
			}
			if (recommendation.recommendationType === "SELL") {
				metric.avoidedLossPercent = 99;
				metric.notes =
					"Criticism/SELL recommendation was correct; token identified as likely scam/rug pull.";
			}
			logger.debug(
				`[CommunityInvestorService] Rec ${recommendation.id} (Scam/Rug): Performance ${metric.potentialProfitPercent || metric.avoidedLossPercent}%`,
			);
			return metric;
		}

		if (pricesAfterRec.length === 0) {
			metric.notes =
				"No significant price data available after recommendation time to evaluate performance yet.";
			if (
				tokenData.currentPrice &&
				tokenData.currentPrice !== priceAtRec &&
				priceAtRec > 0
			) {
				const currentPerformance =
					((tokenData.currentPrice - priceAtRec) / priceAtRec) * 100;
				if (recommendation.recommendationType === "BUY")
					metric.potentialProfitPercent = currentPerformance;
				if (recommendation.recommendationType === "SELL")
					metric.avoidedLossPercent = -currentPerformance;
				metric.notes =
					"Evaluated based on current price vs price at recommendation.";
			} else if (
				priceAtRec === 0 &&
				tokenData.currentPrice &&
				tokenData.currentPrice > 0 &&
				recommendation.recommendationType === "BUY"
			) {
				metric.potentialProfitPercent = Infinity; // Bought at 0, price is now > 0
				metric.notes =
					"Token acquired at effectively zero cost and now has value.";
			} else if (
				priceAtRec > 0 &&
				tokenData.currentPrice === 0 &&
				recommendation.recommendationType === "SELL"
			) {
				metric.avoidedLossPercent = 100; // Sold before it went to zero
				metric.notes = "Token value went to zero after sell recommendation.";
			}
			logger.debug(
				`[CommunityInvestorService] Rec ${recommendation.id} (No prices after): Performance ${metric.potentialProfitPercent || metric.avoidedLossPercent}%`,
			);
			return metric;
		}
		const peakPriceAfterRec = Math.max(
			...pricesAfterRec.map((p) => p.price),
			priceAtRec,
		);
		const troughPriceAfterRec = Math.min(
			...pricesAfterRec.map((p) => p.price),
			priceAtRec,
		);

		if (recommendation.recommendationType === "BUY") {
			if (priceAtRec > 0) {
				if (peakPriceAfterRec > priceAtRec) {
					metric.potentialProfitPercent =
						((peakPriceAfterRec - priceAtRec) / priceAtRec) * 100;
					metric.notes = `Potential profit to peak of $${peakPriceAfterRec.toFixed(4)} from $${priceAtRec.toFixed(4)}.`;
				} else {
					const lossPrice = Math.min(
						tokenData.currentPrice || 0,
						troughPriceAfterRec,
					);
					metric.potentialProfitPercent =
						((lossPrice - priceAtRec) / priceAtRec) * 100;
					metric.notes = `No profitable exit; current/trough price $${lossPrice.toFixed(4)} vs buy $${priceAtRec.toFixed(4)}.`;
				}
			} else {
				// Bought at zero or near-zero
				metric.potentialProfitPercent = peakPriceAfterRec > 0 ? Infinity : 0; // Effectively infinite profit if price rose
				metric.notes = `Bought at effectively zero, peak price $${peakPriceAfterRec.toFixed(4)}.`;
			}
		} else if (recommendation.recommendationType === "SELL") {
			if (priceAtRec > 0) {
				if (troughPriceAfterRec < priceAtRec) {
					metric.avoidedLossPercent =
						((priceAtRec - troughPriceAfterRec) / priceAtRec) * 100;
					metric.notes = `Avoided loss as price dropped to $${troughPriceAfterRec.toFixed(4)} from $${priceAtRec.toFixed(4)}.`;
				} else {
					const missedProfitPrice = Math.max(
						tokenData.currentPrice || 0,
						peakPriceAfterRec,
					);
					metric.avoidedLossPercent =
						((priceAtRec - missedProfitPrice) / priceAtRec) * 100;
					metric.notes = `Missed potential gains; price rose/stayed above $${priceAtRec.toFixed(4)}, reaching $${missedProfitPrice.toFixed(4)}.`;
				}
			} else {
				// Sold at zero (e.g. criticized a non-existent token that remained zero)
				metric.avoidedLossPercent = 0; // No loss to avoid if it started at zero and stayed zero
				metric.notes = `Token was at zero or near-zero at time of sell/criticism.`;
			}
		}
		logger.debug(
			`[CommunityInvestorService] Rec ${recommendation.id}: Performance ${metric.potentialProfitPercent || metric.avoidedLossPercent}%`,
		);
		return metric;
	}

	getRecencyWeight(recommendationTimestamp: number): number {
		const now = Date.now();
		const ageInMilliseconds = now - recommendationTimestamp;
		const ageInMonths = ageInMilliseconds / (1000 * 60 * 60 * 24 * 30.44);
		if (ageInMonths > this.RECENCY_WEIGHT_MONTHS) return 0.1;
		return Math.max(0.1, 1 - (ageInMonths / this.RECENCY_WEIGHT_MONTHS) * 0.9);
	}

	getConvictionWeight(conviction: Recommendation["conviction"]): number {
		switch (conviction) {
			case "HIGH":
				return 1.5;
			case "MEDIUM":
				return 1.0;
			case "LOW":
				return 0.5;
			default:
				return 0.25;
		}
	}

	async calculateUserTrustScore(
		userId: UUID,
		runtime: IAgentRuntime,
		_worldId?: UUID,
	): Promise<number> {
		// Matches interface now
		logger.info(
			`[CommunityInvestorService] Starting calculateUserTrustScore for user ${userId} (components in world/room: ${this.componentWorldId})`,
		);

		const componentResult = await runtime.getComponent(
			userId,
			TRUST_MARKETPLACE_COMPONENT_TYPE,
			this.componentWorldId,
			runtime.agentId!,
		);

		if (!componentResult) {
			// Create new profile for user
			const newProfile: TrustMarketplaceComponentData = {
				version: "1.0.0",
				userId: userId,
				trustScore: 0,
				lastTrustScoreCalculationTimestamp: Date.now(),
				recommendations: [],
			};

			await runtime.createComponent({
				id: userId, // Use userId as component ID
				entityId: userId,
				agentId: runtime.agentId!,
				worldId: this.componentWorldId,
				roomId: this.componentRoomId,
				sourceEntityId: runtime.agentId!,
				type: TRUST_MARKETPLACE_COMPONENT_TYPE,
				createdAt: Date.now(),
				data: newProfile,
			});

			this.registerUser(userId);
			logger.info(
				`[CommunityInvestorService] User ${userId} trust score is now: 0.00. Profile marked for update.`,
			);
			return 0; // Return 0 for new user
		}

		const userProfile = componentResult.data as TrustMarketplaceComponentData;

		// Ensure recommendations array exists
		if (!Array.isArray(userProfile.recommendations)) {
			logger.warn(
				`[calculateUserTrustScore] User ${userId} profile recommendations was not an array. Initializing.`,
			);
			userProfile.recommendations = [];
		}

		// Re-evaluate metrics for recommendations that need it
		let _metricsUpdated = false;
		for (const rec of userProfile.recommendations) {
			if (!rec.tokenAddress || !rec.chain) {
				logger.warn(
					`[calculateUserTrustScore] Rec ${rec.id} for user ${userId} missing address/chain. Skipping metric evaluation.`,
				);
				continue;
			}

			// Check if metrics need re-evaluation
			const needsReEval =
				!rec.metrics?.evaluationTimestamp ||
				Date.now() - rec.metrics.evaluationTimestamp >
					this.METRIC_REFRESH_INTERVAL;

			if (needsReEval) {
				try {
					const tokenData = await this.getTokenAPIData(
						rec.tokenAddress,
						rec.chain as SupportedChain,
					);
					if (!tokenData) {
						logger.warn(
							`[calculateUserTrustScore] No token data for ${rec.tokenAddress} (rec ${rec.id}, user ${userId}) to update metrics.`,
						);
						continue;
					}

					const newMetric = await this.evaluateRecommendationPerformance(
						rec,
						tokenData,
					);
					rec.metrics = newMetric;
					_metricsUpdated = true;
					logger.debug(
						`[calculateUserTrustScore] Updated metrics for rec ${rec.id}, user ${userId}: ${JSON.stringify(newMetric)}`,
					);
				} catch (error) {
					logger.error(
						`[calculateUserTrustScore] Error updating metrics for rec ${rec.id}, user ${userId}:`,
						error,
					);
				}
			} else {
				logger.debug(
					`[calculateUserTrustScore] Rec ${rec.id} for user ${userId} has fresh metrics, skipping re-evaluation.`,
				);
			}

			if (!rec.metrics) {
				logger.warn(
					`[calculateUserTrustScore] Rec ${rec.id} for user ${userId} still has no metrics. It will not contribute to score.`,
				);
			}
		}

		// Calculate new trust score from profile
		const { trustScore: updatedScore } =
			this.calculateNewScoreFromProfile(userProfile);

		userProfile.trustScore = updatedScore;
		userProfile.lastTrustScoreCalculationTimestamp = Date.now();

		// Update the component
		await runtime.updateComponent({
			...componentResult,
			data: userProfile,
		});

		this.registerUser(userId);
		logger.info(
			`[CommunityInvestorService] User ${userId} trust score is now: ${updatedScore.toFixed(2)}. Profile updated.`,
		);

		return updatedScore;
	}

	/**
	 * Calculate trust score from user profile recommendations
	 */
	private calculateNewScoreFromProfile(userProfile: UserTrustProfile): {
		trustScore: number;
	} {
		const recommendations = userProfile.recommendations || [];

		if (recommendations.length === 0) {
			return { trustScore: 0 };
		}

		// Aggregate metrics across all recommendations
		const aggregatedMetrics = {
			totalCalls: recommendations.length,
			profitableCalls: 0,
			totalProfit: 0,
			totalWeightedProfit: 0,
			totalWeight: 0,
			profits: [] as number[],
			rugPromotions: 0,
			goodCalls: 0,
		};

		// Process each recommendation
		for (const rec of recommendations) {
			if (!rec.metrics) continue;

			// Get performance value
			let performance = 0;
			const potentialProfit = rec.metrics.potentialProfitPercent || 0;

			// Detect rugs based on extreme price drops
			const isLikelyRug = rec.metrics.isScamOrRug || potentialProfit <= -80;

			if (isLikelyRug) {
				// Count rug promotions
				if (rec.recommendationType === "BUY") {
					aggregatedMetrics.rugPromotions++;
					performance = -100; // Heavy penalty
				} else if (rec.recommendationType === "SELL") {
					// Good warning about a rug
					aggregatedMetrics.goodCalls++;
					performance = rec.metrics.avoidedLossPercent || 50;
				}
			} else if (rec.recommendationType === "BUY") {
				performance = potentialProfit;
				if (performance > 20) {
					aggregatedMetrics.goodCalls++;
				}
			} else if (rec.recommendationType === "SELL") {
				performance = rec.metrics.avoidedLossPercent || 0;
				// Good warning if token subsequently dropped significantly
				if (potentialProfit < -30) {
					aggregatedMetrics.goodCalls++;
				}
			}

			// Apply weights for weighted average
			const recencyWeight = this.getRecencyWeight(rec.timestamp);
			const convictionWeight = this.getConvictionWeight(rec.conviction);
			const totalRecWeight = recencyWeight * convictionWeight;

			aggregatedMetrics.totalWeightedProfit += performance * totalRecWeight;
			aggregatedMetrics.totalWeight += totalRecWeight;
			aggregatedMetrics.totalProfit += performance;
			aggregatedMetrics.profits.push(performance);

			if (performance > 0) {
				aggregatedMetrics.profitableCalls++;
			}
		}

		// Calculate metrics for balanced trust score
		const winRate =
			aggregatedMetrics.profitableCalls / aggregatedMetrics.totalCalls;
		const averageProfit =
			aggregatedMetrics.totalProfit / aggregatedMetrics.totalCalls;

		// Calculate consistency (standard deviation)
		const profitMean = averageProfit;
		const variance =
			aggregatedMetrics.profits.reduce(
				(sum, p) => sum + (p - profitMean) ** 2,
				0,
			) / aggregatedMetrics.profits.length;
		const stdDev = Math.sqrt(variance);
		const consistency = stdDev > 0 ? Math.max(0, 1 - stdDev / 100) : 1;

		// Simple Sharpe ratio (return / risk)
		const sharpeRatio = stdDev > 0 ? averageProfit / stdDev : 0;

		// Alpha (simplified - performance vs average)
		const marketAverage = 0; // Assume market average is 0 for simplicity
		const alpha = averageProfit - marketAverage;

		// Create metrics object compatible with TrustScoreResult
		const metrics = {
			totalCalls: aggregatedMetrics.totalCalls,
			profitableCalls: aggregatedMetrics.profitableCalls,
			averageProfit,
			winRate,
			sharpeRatio,
			alpha,
			volumePenalty: 0, // Not used in balanced calculator
			consistency,
		};

		// Get user's "archetype" - could be based on their history or default
		// For now, we'll estimate based on their performance
		let archetype = "newbie"; // Default
		if (winRate > 0.7 && averageProfit > 30) {
			archetype = "elite_analyst";
		} else if (winRate > 0.6 && averageProfit > 15) {
			archetype = "skilled_trader";
		} else if (winRate > 0.5) {
			archetype = "technical_analyst";
		} else if (
			aggregatedMetrics.rugPromotions >
			aggregatedMetrics.totalCalls * 0.5
		) {
			archetype = "rug_promoter";
		} else if (aggregatedMetrics.totalCalls > 50 && winRate < 0.3) {
			archetype = "bot_spammer";
		}

		// Calculate balanced trust score
		const trustScore = this.balancedTrustCalculator.calculateBalancedTrustScore(
			metrics,
			archetype,
			aggregatedMetrics.rugPromotions,
			aggregatedMetrics.goodCalls,
			aggregatedMetrics.totalCalls,
		);

		logger.debug(
			`[calculateNewScoreFromProfile] User ${userProfile.userId}: ` +
				`archetype=${archetype}, winRate=${(winRate * 100).toFixed(1)}%, ` +
				`avgProfit=${averageProfit.toFixed(1)}%, trustScore=${trustScore.toFixed(1)}`,
		);

		return { trustScore };
	}

	// --- Task Worker Execution --- (Could be in a separate tasks.ts file)
	private async executeProcessTradeDecision(
		options: { recommendationId: UUID; userId: UUID },
		task: Task,
	): Promise<void> {
		logger.info(
			`[CommunityInvestorService] Task Worker: Processing rec: ${options.recommendationId}, user: ${options.userId}`,
		);
		const { recommendationId, userId } = options;
		const runtime = this.runtime;
		const userProfileWorldId = runtime.agentId as UUID;
		const componentResult = await runtime.getComponent(
			userId,
			TRUST_MARKETPLACE_COMPONENT_TYPE,
			userProfileWorldId,
			runtime.agentId,
		);

		if (!componentResult?.data) {
			logger.error(
				`Task Worker: UserProfile component not found for user ${userId}. Deleting task.`,
			);
			await runtime.deleteTask(task.id as UUID);
			return;
		}
		const userProfile = componentResult.data as TrustMarketplaceComponentData;
		let recommendation = userProfile.recommendations.find(
			(r) => r.id === recommendationId,
		);

		if (!recommendation) {
			logger.error(
				`Task Worker: Rec ${recommendationId} not found in profile for user ${userId}. Deleting task.`,
			);
			await runtime.deleteTask(task.id as UUID);
			return;
		}

		// If already fully processed (and not just for cooldown), delete task.
		if (
			recommendation.processedForTradeDecision &&
			!(
				userProfile.lastTradeDecisionMadeTimestamp &&
				Date.now() - userProfile.lastTradeDecisionMadeTimestamp <
					this.USER_TRADE_COOLDOWN_HOURS * 3600000
			)
		) {
			logger.info(
				`Task Worker: Rec ${recommendationId} already fully processed & not in cooldown. Deleting task.`,
			);
			await runtime.deleteTask(task.id as UUID);
			return;
		}

		// Ensure trust score & recommendation metrics are up-to-date before making a decision.
		// This is important because new data might have come in since the task was created.
		await this.calculateUserTrustScore(userId, runtime);

		const updatedComponent = await runtime.getComponent(
			userId,
			TRUST_MARKETPLACE_COMPONENT_TYPE,
			userProfileWorldId,
			runtime.agentId,
		);
		if (!updatedComponent?.data) {
			logger.error(
				`Task Worker: Profile for ${userId} disappeared after score recalc. Deleting task.`,
			);
			await runtime.deleteTask(task.id as UUID);
			return;
		}
		const updatedUserProfile =
			updatedComponent.data as TrustMarketplaceComponentData;
		const finalTrustScore = updatedUserProfile.trustScore;
		// Refresh recommendation from potentially updated profile data
		recommendation =
			updatedUserProfile.recommendations.find(
				(r) => r.id === recommendationId,
			) || recommendation;

		// Check cooldown again, as calculateUserTrustScore might take time
		const now = Date.now();
		if (
			updatedUserProfile.lastTradeDecisionMadeTimestamp &&
			now - updatedUserProfile.lastTradeDecisionMadeTimestamp <
				this.USER_TRADE_COOLDOWN_HOURS * 3600000
		) {
			logger.info(
				`Task Worker: User ${userId} on trade cooldown (post-score update). Holding on rec ${recommendationId}.`,
			);
			if (recommendation) {
				recommendation.processedForTradeDecision = false; // Keep it false so it can be picked for a real decision later
			} else {
				logger.error(
					"Task Worker: Rec null after profile refresh in cooldown check.",
				);
			}
			await runtime.updateComponent({
				...updatedComponent,
				data: updatedUserProfile,
			});
			await runtime.deleteTask(task.id as UUID);
			return;
		}

		let decisionMade = false;
		if (recommendation.recommendationType === "BUY") {
			if (finalTrustScore > this.POSITIVE_TRADE_THRESHOLD) {
				logger.info(
					`Task Worker: SIMULATING BUY for rec ${recommendationId}. User ${userId}, Score: ${finalTrustScore.toFixed(2)}`,
				);
				updatedUserProfile.lastTradeDecisionMadeTimestamp = now;
				decisionMade = true;
			} else {
				logger.info(
					`Task Worker: HOLDING on BUY rec ${recommendationId}. User ${userId}, Score: ${finalTrustScore.toFixed(2)}, Threshold: >${this.POSITIVE_TRADE_THRESHOLD})`,
				);
			}
		} else {
			// SELL type
			if (finalTrustScore > this.POSITIVE_TRADE_THRESHOLD) {
				logger.info(
					`Task Worker: ACKNOWLEDGING VALID SELL/CRITICISM for rec ${recommendationId}. User ${userId}, Score: ${finalTrustScore.toFixed(2)}`,
				);
				updatedUserProfile.lastTradeDecisionMadeTimestamp = now;
				decisionMade = true;
			} else if (finalTrustScore < -this.NEUTRAL_MARGIN) {
				logger.info(
					`Task Worker: IGNORING POTENTIAL FUD SELL/CRITICISM for rec ${recommendationId}. User ${userId}, Score: ${finalTrustScore.toFixed(2)} (Threshold for FUD: <${-this.NEUTRAL_MARGIN})`,
				);
			} else {
				logger.info(
					`Task Worker: NOTING SELL/CRITICISM for rec ${recommendationId}. User ${userId}, Score: ${finalTrustScore.toFixed(2)}`,
				);
			}
		}

		const recToUpdate = updatedUserProfile.recommendations.find(
			(r) => r.id === recommendationId,
		);
		if (recToUpdate) {
			recToUpdate.processedForTradeDecision = true; // Now it's fully processed for a trade decision cycle
		} else {
			logger.error(
				`[CommunityInvestorService] Task Worker: Could not find rec ${recommendationId} in updated profile to mark as processed.`,
			);
		}

		await runtime.updateComponent({
			...updatedComponent,
			data: updatedUserProfile,
		});
		await runtime.deleteTask(task.id as UUID);
		logger.info(
			`Task Worker: Finished trade decision for rec ${recommendationId}. User: ${userId}. Made Sim Trade: ${decisionMade}`,
		);
	}

	private registerTaskWorkers(runtime: IAgentRuntime): void {
		runtime.registerTaskWorker({
			name: "PROCESS_TRADE_DECISION",
			execute: async (_runtime, options, task) =>
				this.executeProcessTradeDecision(
					options as { recommendationId: UUID; userId: UUID },
					task,
				),
		});
		logger.info(
			"[CommunityInvestorService] Registered PROCESS_TRADE_DECISION task worker.",
		);
	}

	async getLeaderboardData(
		runtime: IAgentRuntime,
	): Promise<LeaderboardEntry[]> {
		logger.info("[CommunityInvestorService] getLeaderboardData called");
		const leaderboardEntries: LeaderboardEntry[] = [];
		// Use the consistent componentWorldId for fetching profiles
		const worldIdForComponents = this.componentWorldId;

		// Use the user registry to get all users who have made recommendations
		logger.info(
			`[CommunityInvestorService] Preparing leaderboard from world ${worldIdForComponents}. Checking ${this.userRegistry.size} registered users from userRegistry: [${Array.from(this.userRegistry).join(", ")}]`,
		);

		for (const userId of this.userRegistry) {
			logger.debug(
				`[CommunityInvestorService] Leaderboard: Processing registered user ${userId} from world ${worldIdForComponents}`,
			);
			try {
				const component = await runtime.getComponent(
					userId,
					TRUST_MARKETPLACE_COMPONENT_TYPE,
					worldIdForComponents, // Use consistent worldId
					runtime.agentId!,
				);

				if (component?.data) {
					const profileData = component.data as TrustMarketplaceComponentData;
					const entityDetails = await runtime.getEntityById(component.entityId);

					const recommendations = Array.isArray(profileData.recommendations)
						? profileData.recommendations
						: [];

					leaderboardEntries.push({
						userId: component.entityId,
						username:
							entityDetails?.names?.[0] || component.entityId.toString(),
						trustScore: profileData.trustScore || 0,
						recommendations: recommendations,
					});

					logger.debug(
						`[CommunityInvestorService] Added user ${userId} to leaderboard with score ${profileData.trustScore}`,
					);
				} else {
					logger.debug(
						`[CommunityInvestorService] Leaderboard: No profile component found for registered user ${userId}`,
					);
				}
			} catch (error) {
				logger.error(
					`[CommunityInvestorService] Leaderboard: Error fetching profile component for user ${userId}:`,
					error,
				);
			}
		}

		logger.info(
			`[CommunityInvestorService] Leaderboard: Found ${leaderboardEntries.length} users with profiles to include.`,
		);

		// Sort by trust score and add ranks
		leaderboardEntries.sort((a, b) => b.trustScore - a.trustScore);
		const rankedLeaderboard = leaderboardEntries.map((entry, index) => ({
			...entry,
			rank: index + 1,
		}));
		logger.info(
			`[CommunityInvestorService] Leaderboard generated with ${rankedLeaderboard.length} entries.`,
		);
		return rankedLeaderboard;
	}

	// Add this method to register a user when they make a recommendation
	private registerUser(userId: UUID): void {
		const originalSize = this.userRegistry.size;
		this.userRegistry.add(userId);
		if (this.userRegistry.size > originalSize) {
			logger.info(
				`[CommunityInvestorService] User ${userId} ADDED to registry. New size: ${this.userRegistry.size}. Registry now: [${Array.from(this.userRegistry).join(", ")}]`,
			);
		} else {
			logger.debug(
				`[CommunityInvestorService] User ${userId} already in registry. Size: ${this.userRegistry.size}`,
			);
		}
		// Persist this to a cache using a key namespaced by the plugin's world ID
		const registryCacheKey = `community-investor:user-registry:${this.componentWorldId}`;
		this.runtime
			.setCache(registryCacheKey, Array.from(this.userRegistry))
			.then(() =>
				logger.debug(
					`[CommunityInvestorService] User registry cache updated for user ${userId} at key ${registryCacheKey}.`,
				),
			)
			.catch((err) =>
				logger.error(
					`[CommunityInvestorService] FAILED to update user registry cache for ${userId} at key ${registryCacheKey}:`,
					err,
				),
			);
	}

	// Load user registry on initialization
	private async loadUserRegistry(): Promise<void> {
		const registryCacheKey = `community-investor:user-registry:${this.componentWorldId}`;
		try {
			const cached = await this.runtime.getCache<UUID[]>(registryCacheKey);
			if (cached && Array.isArray(cached)) {
				this.userRegistry = new Set(cached);
				logger.info(
					`[CommunityInvestorService] Loaded ${this.userRegistry.size} users from registry cache at key ${registryCacheKey}. Users: [${Array.from(this.userRegistry).join(", ")}]`,
				);
			} else {
				logger.info(
					`[CommunityInvestorService] No user registry found in cache at key ${registryCacheKey}, starting fresh.`,
				);
			}
		} catch (error) {
			logger.warn(
				`[CommunityInvestorService] Failed to load user registry from cache at key ${registryCacheKey}:`,
				error,
			);
		}
	}

	private async ensurePluginComponentContext(): Promise<void> {
		try {
			await this.runtime.ensureWorldExists({
				id: this.componentWorldId,
				name: `Social Alpha Global World (Agent: ${this.runtime.agentId})`,
				agentId: this.runtime.agentId,
				serverId: TRUST_LEADERBOARD_WORLD_SEED,
				metadata: {
					plugin_managed: true,
					description: "World context for CommunityInvestor plugin components",
				},
			});
			logger.info(
				`[CommunityInvestorService] Ensured plugin component world ${this.componentWorldId} exists.`,
			);

			await this.runtime.ensureRoomExists({
				id: this.componentRoomId,
				name: `Social Alpha Global Room (Agent: ${this.runtime.agentId})`,
				worldId: this.componentWorldId,
				agentId: this.runtime.agentId,
				channelId: TRUST_LEADERBOARD_WORLD_SEED,
				source: "plugin_internal",
				type: ChannelType.API, // Use API as fallback channel type
				metadata: {
					plugin_managed: true,
					description: "Room context for CommunityInvestor plugin components",
				},
			});
			logger.info(
				`[CommunityInvestorService] Ensured plugin component room ${this.componentRoomId} in world ${this.componentWorldId} exists.`,
			);
		} catch (error) {
			logger.error(
				`[CommunityInvestorService] FAILED to ensure plugin component world/room context (ID: ${this.componentWorldId}):`,
				error,
			);
			// Depending on the severity, you might want to throw this error or handle it
		}
	}

	// ===================== NEW CORE PROCESSING LOGIC =====================

	/**
	 * Processes a batch of historical messages, intended to be called from a script.
	 */
	async processHistoricalData(batch: {
		fileId: string;
		batchIndex: number;
		messages: any[];
		userMap: Record<string, string>;
	}): Promise<any[]> {
		logger.info(
			`[Service] Processing historical batch ${batch.fileId}_${batch.batchIndex}`,
		);
		const { messages, userMap } = batch;

		const contextText = ""; // Historical data processing might not have sequential context in the same way
		const messagesText = messages
			.map(
				(msg, idx) => `[${idx}] ${userMap[msg.uid] || msg.uid}: ${msg.content}`,
			)
			.join("\n");

		const { systemPrompt, userPrompt } = this.buildExtractionPrompts(
			contextText,
			messagesText,
			messages.length,
			"Multiple Users",
		);

		try {
			const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: `${systemPrompt}\n${userPrompt}`,
			});

			const parsed = parseRecommendationExtraction(response);

			if (!parsed?.recommendations || parsed.recommendations.length === 0) {
				logger.debug(
					`[Service] No recommendations extracted from historical batch ${batch.fileId}_${batch.batchIndex}.`,
				);
				return [];
			}

			const callsByUserId = new Map<
				UUID,
				{ messages: any[]; recommendations: any[] }
			>();

			for (const rec of parsed.recommendations) {
				const message = messages[rec.messageIndex];
				if (!message) continue;
				const userId = asUUID(createUniqueUuid(this.runtime, message.uid));
				if (!callsByUserId.has(userId)) {
					callsByUserId.set(userId, { messages: [], recommendations: [] });
				}
				callsByUserId.get(userId)?.messages.push(message);
				callsByUserId.get(userId)?.recommendations.push(rec);
			}

			for (const [userId, data] of callsByUserId.entries()) {
				await this.updateProfileWithRecommendations(
					userId,
					data.messages,
					data.recommendations,
				);
			}

			// This is a placeholder for any data you might want to return from the script
			return parsed.recommendations;
		} catch (error) {
			logger.error(
				`[Service] Error processing historical batch ${batch.fileId}_${batch.batchIndex}:`,
				error,
			);
			return [];
		}
	}

	/**
	 * Main entry point for processing a single, real-time message from the event handler.
	 */
	async processIncomingMessage(message: {
		id?: UUID;
		userId: UUID;
		roomId: UUID;
		text: string;
		timestamp: number;
		username?: string;
	}): Promise<void> {
		const { userId, roomId, text, timestamp, id, username } = message;
		const messageId =
			id || asUUID(createUniqueUuid(this.runtime, `${userId}-${timestamp}`));

		// 1. Get context
		const recentMessages = await this.runtime.getMemories({
			tableName: "messages",
			roomId: roomId,
			count: 10, // Fetch recent messages for context
			unique: false,
		});

		const contextText = recentMessages
			.map(
				(msg) =>
					`${msg.content?.name || msg.entityId.toString()}: ${msg.content?.text || ""}`,
			)
			.join("\n");
		const messagesText = `[0] ${username || userId}: ${text}`;

		// 2. Call LLM for analysis
		const { systemPrompt, userPrompt } = this.buildExtractionPrompts(
			contextText,
			messagesText,
			1,
			username || userId.toString(),
		);

		try {
			const response = await this.runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: `${systemPrompt}\n${userPrompt}`,
			});

			const parsed = parseRecommendationExtraction(response);

			if (!parsed?.recommendations || parsed.recommendations.length === 0) {
				logger.debug(
					`[Service] No recommendations extracted from message ${messageId}.`,
				);
				return;
			}
			const messageForUpdate = {
				id: messageId,
				content: text,
				uid: userId,
				ts: new Date(timestamp).toISOString(),
			};
			// 3. Process the extracted recommendations and update user profile
			await this.updateProfileWithRecommendations(
				userId,
				[messageForUpdate],
				parsed.recommendations,
			);
		} catch (e) {
			logger.error(
				`[Service] Error processing incoming message for user ${userId}:`,
				e,
			);
		}
	}

	/**
	 * Builds the system and user prompts for the recommendation extraction LLM call.
	 */
	private buildExtractionPrompts(
		contextText: string,
		messagesText: string,
		batchSize: number,
		_senderName: string,
	) {
		const systemPrompt = `You are an expert crypto analyst specializing in Discord trading signal extraction. Your goal is to identify crypto-related trading signals, calls, recommendations, or sentiment from messages.

🎯 WHAT COUNTS AS A TRADING SIGNAL:
• Direct trading advice: "buy X", "sell Y", "hold Z"
• Token mentions with $ symbol: $SOL, $PEPE, $DOGE, etc.
• Contract addresses posted for token discovery
• Price predictions: "X going to moon", "Y will dump"
• Market sentiment: "bullish on X", "bearish on Y"
• Technical analysis mentions
• FUD or criticism about specific tokens/projects
• Trading intent: "I'm buying X", "waiting for dip"
• Token performance discussion

🚫 WHAT TO EXCLUDE:
• Rick bot automated messages (User ID: 1081815963990761542)
• Generic DAO/protocol discussion without specific tokens
• Users with "*bot" in username
• Messages about "mintable" (it's a property, not a token)
• General crypto news without specific token focus

🔤 CRYPTO SLANG DICTIONARY:
• fsh = full stack hitler (derogatory)
• dca = dollar cost averaging
• ath = all time high
• atl = all time low
• mcap = market cap
• ser = sir
• ngmi = not gonna make it
• wagmi = we're all gonna make it
• wen = when
• gm = good morning
• ser = sir

⚠️ CRITICAL OUTPUT REQUIREMENTS:
- Respond with JSON only.
- EXACTLY ${batchSize} recommendations entries (messageIndex 0 to ${batchSize - 1})
- Every entry MUST include ALL required fields

REQUIRED JSON SHAPE:
{"recommendations":[{"messageIndex":0,"isCall":true,"tokenMentioned":"SOL","nameMentioned":"","caMentioned":"","chain":"solana","sentiment":"positive","conviction":"medium","llmReasoning":"User mentioned buying $SOL with medium confidence"}]}

FIELD REQUIREMENTS:
• messageIndex: 0 to ${batchSize - 1}
• isCall: true/false
• tokenMentioned: ticker without $ (or "" if none)
• nameMentioned: full token name (or "" if none)  
• caMentioned: contract address (or "" if none)
• chain: "solana", "ethereum", "bitcoin", "base", "unknown"
• sentiment: "positive", "negative", "neutral"
• conviction: "high", "medium", "low", "neutral"
• llmReasoning: 1-2 sentence explanation

VALIDATION RULES:
• If isCall=true: At least ONE of tokenMentioned, nameMentioned, or caMentioned must be non-empty
• If isCall=false: ALL three can be empty
• sentiment "bullish"→"positive", "bearish"→"negative"
• Be VERY generous with extraction - include borderline cases`;

		const userPrompt = `
RECENT CONTEXT:
${contextText}

🔍 ANALYZE THESE ${batchSize} MESSAGES FOR TRADING SIGNALS:
${messagesText}

📋 EXTRACTION RULES:
1. Look for contract addresses: long alphanumeric strings (32-44 chars for Solana, 0x+40 chars for ETH/Base)
2. Extract ANY token mentions: $BTC, $ETH, $SOL, $PEPE, etc.
3. Capture trading sentiment and conviction level
4. Include FUD, criticism, or warnings about tokens
5. Be generous - include subtle references
6. MUST return EXACTLY ${batchSize} results

Examples that SHOULD be extracted:
- "the dev is a CA spammer so we dont know where it could go from here" → negative sentiment about a project
- "Dqyrmg6y7QFhsbCgpkNwnp8wFMs81z3ToPACYAipump is this legit?" → contract address inquiry
- "I will wait for retrace to enter" → trading intent
- "$SOL looking good" → positive sentiment
- "most ai stuff are getting a dump" → negative sentiment on AI tokens
- Contract addresses without context → neutral discovery

RESPOND WITH JSON CONTAINING EXACTLY ${batchSize} RECOMMENDATION ENTRIES:`;
		return { systemPrompt, userPrompt };
	}

	/**
	 * Updates a user's profile with new recommendations extracted from a message batch.
	 */
	private async updateProfileWithRecommendations(
		userId: UUID,
		messagesInBatch: any[], // The original messages that were analyzed
		recommendationsFromLlm: any[], // The raw recommendations from the LLM
	) {
		const component = await this.runtime.getComponent(
			userId,
			TRUST_MARKETPLACE_COMPONENT_TYPE,
			this.componentWorldId,
			this.runtime.agentId!,
		);

		let userProfile: UserTrustProfile;
		if (!component?.data) {
			userProfile = {
				version: "1.0.0",
				userId,
				trustScore: 0,
				lastTrustScoreCalculationTimestamp: Date.now(),
				recommendations: [],
			};
		} else {
			userProfile = component.data as TrustMarketplaceComponentData;
			if (!Array.isArray(userProfile.recommendations))
				userProfile.recommendations = [];
		}

		let profileUpdated = false;
		for (const rec of recommendationsFromLlm) {
			// Skip if not a call or no token information provided
			if (!rec.isCall || rec.sentiment === "neutral") {
				continue;
			}

			// Check if we have at least one token identifier
			const hasTokenMention =
				rec.tokenMentioned?.trim() && rec.tokenMentioned !== "N/A";
			const hasNameMention = rec.nameMentioned?.trim();
			const hasContractAddress = rec.caMentioned?.trim();

			if (!hasTokenMention && !hasNameMention && !hasContractAddress) {
				continue;
			}

			const originalMessage = messagesInBatch[rec.messageIndex];
			if (!originalMessage) continue;

			// Try to resolve token, preferring contract address, then ticker, then name
			let resolvedToken = null;

			if (hasContractAddress) {
				// For contract addresses, use them directly
				resolvedToken = {
					address: rec.caMentioned,
					chain: (rec.chain as SupportedChain) || SupportedChain.SOLANA,
					ticker:
						rec.tokenMentioned ||
						rec.nameMentioned ||
						rec.caMentioned.slice(0, 8),
				};
			} else if (hasTokenMention) {
				resolvedToken = await this.resolveTicker(
					rec.tokenMentioned,
					(rec.chain as SupportedChain) || SupportedChain.SOLANA,
				);
			} else if (hasNameMention) {
				resolvedToken = await this.resolveTicker(
					rec.nameMentioned,
					(rec.chain as SupportedChain) || SupportedChain.SOLANA,
				);
			}

			if (!resolvedToken) {
				logger.warn(
					`[Service] Could not resolve token for: "${rec.tokenMentioned || rec.nameMentioned || rec.caMentioned}". Skipping.`,
				);
				continue;
			}

			const newRecommendation: Recommendation = {
				id: asUUID(uuidv4()),
				userId: userId,
				messageId: originalMessage.id,
				timestamp: new Date(originalMessage.ts).getTime(),
				tokenTicker: resolvedToken.ticker,
				tokenAddress: resolvedToken.address,
				chain: resolvedToken.chain,
				recommendationType: rec.sentiment === "positive" ? "BUY" : "SELL",
				conviction: rec.conviction as Conviction,
				rawMessageQuote: originalMessage.content,
				priceAtRecommendation: 0,
				processedForTradeDecision: false,
			};

			userProfile.recommendations.unshift(newRecommendation);
			profileUpdated = true;

			logger.info(
				`[Service] Added ${rec.sentiment.toUpperCase()} recommendation for ${resolvedToken.ticker} from user ${userId}`,
			);

			await this.runtime.createTask({
				name: "PROCESS_TRADE_DECISION",
				description: `Process trade decision for rec ${newRecommendation.id}`,
				metadata: { recommendationId: newRecommendation.id, userId },
				tags: ["socialAlpha", "tradeDecision"],
				roomId: this.componentRoomId,
				worldId: this.componentWorldId,
				entityId: userId,
			});
		}

		if (profileUpdated) {
			if (component) {
				await this.runtime.updateComponent({
					...component,
					data: userProfile,
				});
			} else {
				const newComponentId = asUUID(
					createUniqueUuid(this.runtime, userId.toString()),
				);
				await this.runtime.createComponent({
					id: newComponentId,
					entityId: userId,
					agentId: this.runtime.agentId!,
					worldId: this.componentWorldId,
					roomId: this.componentRoomId,
					sourceEntityId: this.runtime.agentId!,
					type: TRUST_MARKETPLACE_COMPONENT_TYPE,
					createdAt: Date.now(),
					data: userProfile,
				});
			}
			await this.calculateUserTrustScore(userId, this.runtime);
		}
	}
}
