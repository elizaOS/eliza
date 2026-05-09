import type { IAgentRuntime } from "@elizaos/core";
import { BirdeyeClient, DexscreenerClient } from "../clients.ts";
import { SupportedChain } from "../types.ts";

export interface PricePoint {
	timestamp: number;
	price: number;
	volume?: number;
	liquidity?: number;
}

export interface HistoricalPriceData {
	address: string;
	chain: SupportedChain;
	priceHistory: PricePoint[];
	firstPrice?: number;
	lastPrice?: number;
	minPrice?: number;
	maxPrice?: number;
	fetchedAt: number;
}

export interface TokenResolution {
	symbol: string;
	address: string;
	name: string;
	chain: SupportedChain;
	liquidity?: number;
	volume24h?: number;
	marketCap?: number;
	createdAt?: number;
}

export class HistoricalPriceService {
	private runtime: IAgentRuntime;
	private runtime: IAgentRuntime;
	private birdeyeClient: BirdeyeClient;
	private dexscreenerClient: DexscreenerClient;

	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		this.birdeyeClient = BirdeyeClient.createFromRuntime(runtime);
		this.dexscreenerClient = DexscreenerClient.createFromRuntime(runtime);
	}

	/**
	 * Fetch historical price data from Birdeye using OHLCV endpoint
	 */
	async fetchBirdeyeHistoricalPrices(
		address: string,
		fromTimestamp: number,
		toTimestamp: number,
	): Promise<HistoricalPriceData | null> {
		try {
			// Convert timestamps to seconds (Birdeye expects seconds)
			const fromSec = Math.floor(fromTimestamp / 1000);
			const toSec = Math.floor(toTimestamp / 1000);

			// Try OHLCV endpoint
			const ohlcvData = await this.birdeyeClient.request<{
				items: Array<{
					unixTime: number;
					o: number; // open
					h: number; // high
					l: number; // low
					c: number; // close
					v: number; // volume
				}>;
			}>(
				"defi/ohlcv",
				{
					address,
					type: "1H", // 1 hour intervals
					time_from: fromSec,
					time_to: toSec,
				},
				{ chain: "solana" },
			);

			if (!ohlcvData?.items || ohlcvData.items.length === 0) {
				// Fallback to current price only
				const currentPrice = await this.birdeyeClient.fetchPrice(address);
				if (currentPrice) {
					return {
						address,
						chain: SupportedChain.SOLANA,
						priceHistory: [
							{
								timestamp: Date.now(),
								price: currentPrice,
							},
						],
						firstPrice: currentPrice,
						lastPrice: currentPrice,
						minPrice: currentPrice,
						maxPrice: currentPrice,
						fetchedAt: Date.now(),
					};
				}
				return null;
			}

			const priceHistory: PricePoint[] = ohlcvData.items.map((item) => ({
				timestamp: item.unixTime * 1000,
				price: item.c, // Use closing price
				volume: item.v,
			}));

			const prices = priceHistory.map((p) => p.price);

			return {
				address,
				chain: SupportedChain.SOLANA,
				priceHistory,
				firstPrice: prices[0],
				lastPrice: prices[prices.length - 1],
				minPrice: Math.min(...prices),
				maxPrice: Math.max(...prices),
				fetchedAt: Date.now(),
			};
		} catch (error: any) {
			// If OHLCV fails, try to get current price at least
			console.warn(
				`OHLCV failed for ${address}, trying current price:`,
				error.message,
			);

			try {
				const currentPrice = await this.birdeyeClient.fetchPrice(address);
				if (currentPrice) {
					return {
						address,
						chain: SupportedChain.SOLANA,
						priceHistory: [
							{
								timestamp: Date.now(),
								price: currentPrice,
							},
						],
						firstPrice: currentPrice,
						lastPrice: currentPrice,
						minPrice: currentPrice,
						maxPrice: currentPrice,
						fetchedAt: Date.now(),
					};
				}
			} catch (priceError) {
				console.error(
					`Failed to get any price data for ${address}:`,
					priceError,
				);
			}

			return null;
		}
	}

	/**
	 * Fetch historical price data from Dexscreener
	 * Note: DexScreener doesn't provide true historical data, only recent price changes
	 */
	async fetchDexscreenerHistoricalPrices(
		address: string,
		chain: SupportedChain,
		_fromTimestamp: number,
		_toTimestamp: number,
	): Promise<HistoricalPriceData | null> {
		try {
			// Search for the token
			const searchResults = await this.dexscreenerClient.search(address);
			if (!searchResults?.pairs || searchResults.pairs.length === 0) {
				return null;
			}

			// Find the best pair for this chain
			const chainId = this.getChainId(chain);
			const pair =
				searchResults.pairs.find(
					(p) =>
						p.baseToken.address.toLowerCase() === address.toLowerCase() &&
						p.chainId === chainId,
				) || searchResults.pairs[0];

			if (!pair || !pair.priceUsd) {
				return null;
			}

			// Build price history from available data
			const priceHistory: PricePoint[] = [];
			const currentPrice = parseFloat(pair.priceUsd);
			const now = Date.now();

			// Add current price
			priceHistory.push({
				timestamp: now,
				price: currentPrice,
				volume: pair.volume?.h24,
				liquidity: pair.liquidity?.usd,
			});

			// Add historical prices based on % changes
			if (pair.priceChange) {
				// 5 minute ago
				if (pair.priceChange.m5 !== undefined) {
					const price5m = currentPrice / (1 + pair.priceChange.m5 / 100);
					priceHistory.push({
						timestamp: now - 5 * 60 * 1000,
						price: price5m,
					});
				}

				// 1 hour ago
				if (pair.priceChange.h1 !== undefined) {
					const price1h = currentPrice / (1 + pair.priceChange.h1 / 100);
					priceHistory.push({
						timestamp: now - 60 * 60 * 1000,
						price: price1h,
					});
				}

				// 6 hours ago
				if (pair.priceChange.h6 !== undefined) {
					const price6h = currentPrice / (1 + pair.priceChange.h6 / 100);
					priceHistory.push({
						timestamp: now - 6 * 60 * 60 * 1000,
						price: price6h,
					});
				}

				// 24 hours ago
				if (pair.priceChange.h24 !== undefined) {
					const price24h = currentPrice / (1 + pair.priceChange.h24 / 100);
					priceHistory.push({
						timestamp: now - 24 * 60 * 60 * 1000,
						price: price24h,
					});
				}
			}

			// Sort by timestamp
			priceHistory.sort((a, b) => a.timestamp - b.timestamp);

			const prices = priceHistory.map((p) => p.price);

			return {
				address,
				chain,
				priceHistory,
				firstPrice: prices[0],
				lastPrice: prices[prices.length - 1],
				minPrice: Math.min(...prices),
				maxPrice: Math.max(...prices),
				fetchedAt: Date.now(),
			};
		} catch (error) {
			console.error(`Error fetching Dexscreener data for ${address}:`, error);
			return null;
		}
	}

	/**
	 * Get price at specific timestamp using interpolation
	 */
	getPriceAtTimestamp(
		historicalData: HistoricalPriceData,
		timestamp: number,
	): number | null {
		const priceHistory = historicalData.priceHistory;

		if (priceHistory.length === 0) return null;

		// If timestamp is before first data point, return first price
		if (timestamp <= priceHistory[0].timestamp) {
			return priceHistory[0].price;
		}

		// If timestamp is after last data point, return last price
		if (timestamp >= priceHistory[priceHistory.length - 1].timestamp) {
			return priceHistory[priceHistory.length - 1].price;
		}

		// Find surrounding data points for interpolation
		for (let i = 0; i < priceHistory.length - 1; i++) {
			if (
				timestamp >= priceHistory[i].timestamp &&
				timestamp <= priceHistory[i + 1].timestamp
			) {
				// Linear interpolation
				const t1 = priceHistory[i].timestamp;
				const t2 = priceHistory[i + 1].timestamp;
				const p1 = priceHistory[i].price;
				const p2 = priceHistory[i + 1].price;

				const ratio = (timestamp - t1) / (t2 - t1);
				return p1 + (p2 - p1) * ratio;
			}
		}

		return null;
	}

	/**
	 * Get max price in time window
	 */
	getMaxPriceInWindow(
		historicalData: HistoricalPriceData,
		fromTimestamp: number,
		toTimestamp: number,
	): { price: number; timestamp: number } | null {
		const pricesInWindow = historicalData.priceHistory.filter(
			(p) => p.timestamp >= fromTimestamp && p.timestamp <= toTimestamp,
		);

		if (pricesInWindow.length === 0) {
			// If no data points in window, check if we can extrapolate
			const priceAtStart = this.getPriceAtTimestamp(
				historicalData,
				fromTimestamp,
			);
			const priceAtEnd = this.getPriceAtTimestamp(historicalData, toTimestamp);

			if (priceAtStart !== null && priceAtEnd !== null) {
				return priceAtStart >= priceAtEnd
					? { price: priceAtStart, timestamp: fromTimestamp }
					: { price: priceAtEnd, timestamp: toTimestamp };
			}

			return null;
		}

		let maxPrice = pricesInWindow[0];
		for (const point of pricesInWindow) {
			if (point.price > maxPrice.price) {
				maxPrice = point;
			}
		}

		return { price: maxPrice.price, timestamp: maxPrice.timestamp };
	}

	/**
	 * Search for best token match by symbol
	 */
	async findBestTokenMatch(
		symbol: string,
		chain: SupportedChain,
	): Promise<TokenResolution | null> {
		try {
			// Search on Dexscreener first (better for finding tokens by symbol)
			const searchResults = await this.dexscreenerClient.search(symbol);

			if (!searchResults?.pairs || searchResults.pairs.length === 0) {
				return null;
			}

			// Filter by chain and find best match
			const chainId = this.getChainId(chain);
			const candidates = searchResults.pairs
				.filter(
					(pair) =>
						pair.chainId === chainId &&
						pair.baseToken.symbol.toUpperCase() === symbol.toUpperCase(),
				)
				.sort((a, b) => {
					// Sort by liquidity, then volume, then age
					const liquidityA = a.liquidity?.usd || 0;
					const liquidityB = b.liquidity?.usd || 0;

					if (liquidityA !== liquidityB) {
						return liquidityB - liquidityA;
					}

					const volumeA = a.volume?.h24 || 0;
					const volumeB = b.volume?.h24 || 0;

					if (volumeA !== volumeB) {
						return volumeB - volumeA;
					}

					// Prefer newer tokens (higher pair address usually means newer)
					return (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0);
				});

			if (candidates.length === 0) {
				return null;
			}

			const bestMatch = candidates[0];

			// Check if it meets minimum liquidity requirements
			const liquidityUsd = bestMatch.liquidity?.usd || 0;
			const marketCap = bestMatch.fdv || 0;
			const minLiquidityRatio = 10000 / 1000000; // $10k per $1M market cap

			if (marketCap > 0 && liquidityUsd / marketCap < minLiquidityRatio) {
				console.warn(
					`Token ${symbol} has insufficient liquidity ratio: ${liquidityUsd / marketCap}`,
				);
			}

			return {
				symbol: bestMatch.baseToken.symbol,
				address: bestMatch.baseToken.address,
				name: bestMatch.baseToken.name,
				chain,
				liquidity: liquidityUsd,
				volume24h: bestMatch.volume?.h24,
				marketCap: bestMatch.fdv,
				createdAt: bestMatch.pairCreatedAt,
			};
		} catch (error) {
			console.error(`Error finding best token match for ${symbol}:`, error);
			return null;
		}
	}

	private getChainId(chain: SupportedChain): string {
		switch (chain) {
			case SupportedChain.SOLANA:
				return "solana";
			case SupportedChain.ETHEREUM:
				return "ethereum";
			case SupportedChain.BASE:
				return "base";
			default:
				return "solana";
		}
	}
}
