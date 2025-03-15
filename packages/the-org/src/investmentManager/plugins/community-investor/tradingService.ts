import {
	type Entity,
	type IAgentRuntime,
	type Memory,
	ModelType,
	Service,
	type UUID,
	logger
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import {
	BirdeyeClient,
	CoingeckoClient,
	DexscreenerClient,
	HeliusClient,
} from "./clients";
import {
	DEFAULT_TRADING_CONFIG,
	type TradingConfig,
	getConvictionMultiplier,
	getLiquidityMultiplier,
	getMarketCapMultiplier,
	getVolumeMultiplier,
} from "./config";
import { formatFullReport } from "./reports";
import {
	type BuySignalMessage,
	Conviction,
	type Position,
	type PositionWithBalance,
	type ProcessedTokenData,
	RecommendationType,
	type RecommenderMetrics,
	type RecommenderMetricsHistory,
	ServiceType,
	type TokenMarketData,
	type TokenMetadata,
	type TokenPerformance,
	type TokenRecommendation,
	type TokenSecurityData,
	type TokenTradeData,
	type Transaction,
	TransactionType,
} from "./types";

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
export class CommunityInvestorService extends Service {
	static serviceType = ServiceType.COMMUNITY_INVESTOR;
	capabilityDescription = "The agent is able to trade on the Solana blockchain";

	// Client instances
	private birdeyeClient: BirdeyeClient;
	private dexscreenerClient: DexscreenerClient;
	private coingeckoClient: CoingeckoClient | null = null;
	private heliusClient: HeliusClient | null = null;

	// Configuration
	tradingConfig: TradingConfig;

	// Event listeners
	private eventListeners: Map<string, ((event: TradingEvent) => void)[]> =
		new Map();

	constructor(protected runtime: IAgentRuntime) {
		super(runtime);

		// Initialize API clients
		this.birdeyeClient = BirdeyeClient.createFromRuntime(runtime);
		this.dexscreenerClient = DexscreenerClient.createFromRuntime(runtime);

		try {
			this.coingeckoClient = CoingeckoClient.createFromRuntime(runtime);
		} catch (error) {
			logger.warn(
				"Failed to initialize Coingecko client, prices may be limited:",
				error,
			);
		}

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
	}

	static async start(
		runtime: IAgentRuntime,
	): Promise<CommunityInvestorService> {
		const tradingService = new CommunityInvestorService(runtime);
		return tradingService;
	}

	static async stop(runtime: IAgentRuntime): Promise<void> {
		const tradingService = runtime.getService("trading");
		if (tradingService) {
			await tradingService.stop();
		}
	}

	async stop(): Promise<void> {
		return Promise.resolve();
	}

	/**
	 * Add an event listener for trading events
	 */
	addEventListener(
		eventId: string,
		listener: (event: TradingEvent) => void,
	): void {
		if (!this.eventListeners.has(eventId)) {
			this.eventListeners.set(eventId, []);
		}
		this.eventListeners.get(eventId).push(listener);
	}

	/**
	 * Remove an event listener
	 */
	removeEventListener(eventId: string): void {
		logger.debug("removing event listener", eventId);
		this.eventListeners.delete(eventId);
	}

	/**
	 * Emit a trading event to all listeners
	 */
	private emitEvent(event: TradingEvent): void {
		logger.debug("emitting event", event);
		for (const listeners of this.eventListeners.values()) {
			for (const listener of listeners) {
				try {
					listener(event);
				} catch (error) {
					logger.error("Error in event listener:", error);
				}
			}
		}
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
			this.emitEvent({ type: "position_opened", position });

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
			this.emitEvent({ type: "position_closed", position: updatedPosition });

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
				const cachedData = await this.runtime
					
					.getCache<TokenMetadata & TokenMarketData>(cacheKey);

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
					await this.runtime
						
						.setCache<TokenMetadata & TokenMarketData>(cacheKey, tokenData); // Cache for 5 minutes

					return tokenData;
				}
			}

			// Need to fetch fresh data
			if (chain.toLowerCase() === "solana") {
				const [dexScreenerData, birdeyeData] = await Promise.all([
					this.dexscreenerClient.searchForHighestLiquidityPair(
						tokenAddress,
						chain,
						{ expires: "5m" },
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
				await this.runtime
					
					.setCache<TokenMetadata & TokenMarketData>(cacheKey, tokenData); // Cache for 5 minutes

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
	async resolveTicker(chain: string, ticker: string): Promise<string | null> {
		logger.debug("resolving ticker", chain, ticker);
		// Check cache first
		const cacheKey = `ticker:${chain}:${ticker}`;
		const cachedAddress = await this.runtime
			
			.getCache<string>(cacheKey);

		if (cachedAddress) {
			return cachedAddress;
		}

		if (chain.toLowerCase() === "solana") {
			const result = await this.dexscreenerClient.searchForHighestLiquidityPair(
				ticker,
				chain,
				{
					expires: "5m",
				},
			);

			const address = result?.baseToken?.address || null;

			// Cache the result if found
			if (address) {
				await this.runtime
					
					.setCache<string>(cacheKey, address); // Cache for 1 hour
			}

			return address;
		}
		throw new Error(`Chain ${chain} not supported for ticker resolution`);
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
				await this.runtime
					
					.setCache<string>(cacheKey, token.price.toString()); // Cache for 1 minute
				return token.price;
			}

			// Fetch fresh price
			if (chain.toLowerCase() === "solana") {
				const price = await this.birdeyeClient.fetchPrice(tokenAddress, {
					chain: "solana",
				});

				// Cache the price
				await this.runtime
					
					.setCache<string>(cacheKey, price.toString()); // Cache for 1 minute

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

			if (
				!dexScreenerData ||
				!dexScreenerData.pairs ||
				dexScreenerData.pairs.length === 0
			) {
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
			const cachedData = await this.runtime.getCache<ProcessedTokenData>(cacheKey);

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

				let tokenInfo;

				// Analyze holder distribution
				const holderDistributionTrend =
					await this.analyzeHolderDistribution(tokenTradeData);

				// Try to get holder data if Helius client is available
				let highValueHolders = [];
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
				await this.runtime
					
					.setCache<ProcessedTokenData>(cacheKey, processedData); // Cache for 5 minutes

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
			this.emitEvent({
				type: "token_performance_updated",
				performance,
			});

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
			this.emitEvent({
				type: "recommendation_added",
				recommendation,
			});

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

		// Try to get actual metrics
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
			this.emitEvent({ type: "transaction_added", transaction });

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
				await this.runtime
					
					.setCache<Position>(cacheKey, position); // Cache for 5 minutes

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
				if (
					(memory.metadata as any).recommendation &&
					(memory.metadata as any).recommendation.entityId === entityId
				) {
					recommendations.push(
						(memory.metadata as any).recommendation as TokenRecommendation,
					);
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
			this.emitEvent({ type: "position_closed", position });

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
			await this.runtime
				
				.setCache<TokenPerformance>(cacheKey, token); // Cache for 5 minutes
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
			await this.runtime
				
				.setCache<Position>(cacheKey, position);
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
				await this.runtime
					
					.setCache<Transaction[]>(cacheKey, txs); // Cache for 5 minutes
			} else {
				await this.runtime
					
					.setCache<Transaction[]>(cacheKey, [transaction]); // Cache for 5 minutes
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
			await this.runtime
				
				.setCache<TokenRecommendation>(cacheKey, recommendation); // Cache for 5 minutes
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
			await this.runtime
				
				.setCache<RecommenderMetrics>(cacheKey, metrics); // Cache for 5 minutes
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
			const cachedHistory = await this.runtime.getCache<RecommenderMetricsHistory[]>(cacheKey);

			if (cachedHistory) {
				const histories = cachedHistory as RecommenderMetricsHistory[];
				histories.push(history);
				// Keep only the last 10 entries
				const recentHistories = histories
					.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
					.slice(0, 10);
				await this.runtime
					
					.setCache<RecommenderMetricsHistory[]>(cacheKey, recentHistories); // Cache for 1 hour
			} else {
				await this.runtime
					
					.setCache<RecommenderMetricsHistory[]>(cacheKey, [history]); // Cache for 1 hour
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
			const cachedMetrics = await this.runtime.getCache<RecommenderMetrics>(cacheKey);

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
				await this.runtime
					
					.setCache<RecommenderMetrics>(cacheKey, metrics); // Cache for 5 minutes

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
			const cachedHistory = await this.runtime.getCache<RecommenderMetricsHistory[]>(cacheKey);

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
			await this.runtime
				
				.setCache<RecommenderMetricsHistory[]>(cacheKey, sortedEntries); // Cache for 1 hour

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
			const cachedToken = await this.runtime.getCache<TokenPerformance>(cacheKey);

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
				await this.runtime
					
					.setCache<TokenPerformance>(cacheKey, token); // Cache for 5 minutes

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
			const cachedPositions = await this.runtime.getCache<PositionWithBalance[]>(cacheKey);

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
			await this.runtime
				
				.setCache<PositionWithBalance[]>(cacheKey, positions); // Cache for 5 minutes

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
${report.positionReports.join("\n\n")}

Tokens:
${report.tokenReports.join("\n\n")}
            `.trim();
		} catch (error) {
			logger.error("Error generating portfolio report:", error);
			return "Error generating portfolio report.";
		}
	}
}
