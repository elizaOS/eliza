import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";
import { elizaLogger, settings } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import {
    solanaPlugin,
    trustScoreProvider,
    trustEvaluator,
    getTokenBalance,
} from "@elizaos/plugin-solana";
import { TokenProvider } from "./providers/token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { WalletClient, Signature, Balance } from "@goat-sdk/core";
import * as fs from "fs";
import * as path from "path";
import { TrustScoreProvider } from "./providers/trustScoreProvider";
import { SimulationService } from "./services/simulationService";
import { SAFETY_LIMITS } from "./constants";
import NodeCache from "node-cache";
import { TrustScoreDatabase } from "@elizaos/plugin-trustdb";
import { v4 as uuidv4 } from "uuid";
import { actions } from "./actions";
import {
    tweetTrade,
    TwitterConfigSchema,
    TwitterService,
} from "./services/twitter";
import {
    executeTrade,
    getChainWalletBalance,
    getWalletBalance,
    getWalletKeypair,
} from "./wallet";
import type { ProcessedTokenData } from "./types";
import { analyzeTradeAction } from "./actions/analyzeTrade";

// Update Balance interface to include formatted
interface ExtendedBalance extends Balance {
    formatted: string;
}

// Extended WalletProvider interface to ensure proper typing
interface ExtendedWalletProvider extends WalletClient {
    connection: Connection;
    signMessage(message: string): Promise<Signature>;
    getFormattedPortfolio: (runtime: IAgentRuntime) => Promise<string>;
    balanceOf: (tokenAddress: string) => Promise<ExtendedBalance>;
    getMaxBuyAmount: (tokenAddress: string) => Promise<number>;
    executeTrade: (params: {
        tokenIn: string;
        tokenOut: string;
        amountIn: number;
        slippage: number;
    }) => Promise<any>;
}

const REQUIRED_SETTINGS = {
    WALLET_PUBLIC_KEY: "Solana wallet public key",
    DEXSCREENER_WATCHLIST_ID: "DexScreener watchlist ID",
    COINGECKO_API_KEY: "CoinGecko API key",
} as const;

// Add near the top imports
interface ExtendedPlugin extends Plugin {
    name: string;
    description: string;
    evaluators: any[];
    providers: any[];
    actions: any[];
    services: any[];
    autoStart?: boolean;
}

// Add this helper function
function validateSolanaAddress(address: string | undefined): boolean {
    if (!address) return false;
    try {
        // Handle Solana addresses
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            elizaLogger.warn(`Solana address failed format check: ${address}`);
            return false;
        }

        // Verify it's a valid Solana public key
        const pubKey = new PublicKey(address);
        const isValid = Boolean(pubKey.toBase58());
        elizaLogger.log(
            `Solana address validation result for ${address}: ${isValid}`
        );
        return isValid;
    } catch (error) {
        elizaLogger.error(`Address validation error for ${address}:`, error);
        return false;
    }
}

// Add function to load token addresses
export function loadTokenAddresses(): string[] {
    try {
        const filePath = path.resolve(
            process.cwd(),
            "../characters/tokens/tokenaddresses.json"
        );
        const data = fs.readFileSync(filePath, "utf8");
        const addresses = JSON.parse(data);

        // Validate addresses
        const validAddresses = addresses.filter((addr: string) => {
            // Solana address validation
            return validateSolanaAddress(addr);
        });

        elizaLogger.log("Loaded token addresses:", {
            total: validAddresses.length,
            solana: validAddresses.filter((addr) => !addr.startsWith("0x"))
                .length,
            base: validAddresses.filter((addr) => addr.startsWith("0x")).length,
        });

        return validAddresses;
    } catch (error) {
        elizaLogger.error("Failed to load token addresses:", error);
        throw new Error("Token addresses file not found or invalid");
    }
}

// Add cache configuration after other interfaces
interface CacheEntry {
    lastAnalysis: number;
    tokenData: any;
    trustScore: number;
    analysisResult: any;
}

// Add cache instance before createGoatPlugin
const tokenCache = new NodeCache({
    stdTTL: 1200, // 20 minutes in seconds
    checkperiod: 120, // Check for expired entries every 2 minutes
});

/*
// Add near the top with other interfaces
interface SkipWaitCache {
    lastTweet: number;
    action: "WAIT" | "SKIP";
}

// Add near other cache instances
const skipWaitCache = new NodeCache({
    stdTTL: 7200, // 2 hours in seconds
    checkperiod: 600, // Check for expired entries every 10 minutes
});

// Add near other interfaces
interface TweetRateLimit {
    lastTweet: number;
    count: number; // Track number of tweets in the time window
}

// Add near other cache instances
const tweetRateCache = new NodeCache({
    stdTTL: 86400, // 24 hours in seconds
    checkperiod: 3600, // Check every hour
});

// Add helper function
function canTweet(tweetType: "trade" | "market_search"): boolean {
    const now = Date.now();
    const hourKey = `tweets_${tweetType}_${Math.floor(now / 3600000)}`; // Key by hour and type
    const rateLimit: TweetRateLimit = tweetRateCache.get(hourKey) || {
        lastTweet: now,
        count: 0,
    };

    // Different limits for different tweet types
    const MAX_TWEETS_PER_HOUR = {
        trade: 10,
        market_search: 10, // Lower limit for market search tweets
    };

    if (rateLimit.count >= MAX_TWEETS_PER_HOUR[tweetType]) {
        elizaLogger.warn(
            `Tweet rate limit reached for ${tweetType}: ${rateLimit.count} tweets this hour`
        );
        return false;
    }

    // Update rate limit
    tweetRateCache.set(hourKey, {
        lastTweet: now,
        count: rateLimit.count + 1,
    });

    return true;
}
*/

// Add new interfaces near the top with other interfaces
interface TradePerformance {
    token_address: string;
    recommender_id: string;
    buy_price: number;
    sell_price: number;
    buy_timeStamp: string;
    sell_timeStamp: string;
    buy_amount: number;
    sell_amount: number;
    buy_value_usd: number;
    sell_value_usd: number;
    buy_market_cap: number;
    sell_market_cap: number;
    buy_liquidity: number;
    sell_liquidity: number;
    profit_usd: number;
    profit_percent: number;
    market_cap_change: number;
    liquidity_change: number;
    rapidDump: boolean;
}

interface TradePosition {
    token_address: string;
    entry_price: number;
    size: number;
    stop_loss: number;
    take_profit: number;
    open_timeStamp: string;
    close_timeStamp?: string;
    status?: "OPEN" | "CLOSED";
}

// Update the analysisParams interface
interface AnalysisParams extends Record<string, any> {
    walletBalance: number;
    tokenAddress: string;
    price: number;
    volume: number;
    marketCap: number;
    liquidity: number;
    holderDistribution: string;
    trustScore: number;
    dexscreener: any;
    position?: TradePosition;
    tradeHistory?: TradePerformance[];
}

// Update the interface to match the SQL parameter order
interface SellDetailsData {
    // SET clause parameters in order
    sell_price: number;
    sell_timeStamp: string;
    sell_amount: number;
    received_sol: number;
    sell_value_usd: number;
    profit_usd: number;
    profit_percent: number;
    sell_market_cap: number;
    market_cap_change: number;
    sell_liquidity: number;
    liquidity_change: number;
    rapidDump: boolean;
    sell_recommender_id: string | null;
}

async function updateSellDetails(
    runtime: IAgentRuntime,
    tokenAddress: string,
    recommenderId: string,
    tradeAmount: number,
    latestTrade: any,
    tokenData: any
) {
    const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);

    const trade = await trustScoreDb.getLatestTradePerformance(
        tokenAddress,
        recommenderId,
        false
    );

    if (!trade) {
        elizaLogger.error(
            `No trade found for token ${tokenAddress} and recommender ${recommenderId}`
        );
        throw new Error("No trade found to update");
    }

    const currentPrice = tokenData.dexScreenerData.pairs[0]?.priceUsd || 0;
    const marketCap = tokenData.dexScreenerData.pairs[0]?.marketCap || 0;
    const liquidity = tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0;

    const sellValueUsd = tradeAmount * Number(currentPrice);
    const profitUsd = sellValueUsd - trade.buy_value_usd;
    const profitPercent = (profitUsd / trade.buy_value_usd) * 100;

    // Create sellDetailsData object matching SQL parameter order
    const sellDetails: SellDetailsData = {
        sell_price: Number(currentPrice),
        sell_timeStamp: new Date().toISOString(),
        sell_amount: tradeAmount,
        received_sol: tradeAmount,
        sell_value_usd: sellValueUsd,
        profit_usd: profitUsd,
        profit_percent: profitPercent,
        sell_market_cap: marketCap,
        market_cap_change: marketCap - trade.buy_market_cap,
        sell_liquidity: liquidity,
        liquidity_change: liquidity - trade.buy_liquidity,
        rapidDump: false,
        sell_recommender_id: recommenderId || null,
    };

    elizaLogger.log("Attempting to update trade performance with data:", {
        sellDetails,
        whereClause: {
            tokenAddress,
            recommenderId,
            buyTimeStamp: trade.buy_timeStamp,
        },
        isSimulation: false,
    });

    try {
        try {
            // Pass sellDetails first (SET clause), then WHERE clause parameters
            elizaLogger.log(
                "Verifying parameters for updateTradePerformanceOnSell:",
                {
                    sellDetails,
                    tokenAddress,
                    recommenderId,
                    buyTimeStamp: trade.buy_timeStamp,
                    isSimulation: false,
                }
            );

            const success = await trustScoreDb.updateTradePerformanceOnSell(
                tokenAddress, // 1. WHERE token_address = ?
                recommenderId, // 2. WHERE recommender_id = ?
                trade.buy_timeStamp, // 3. WHERE buy_timeStamp = ?
                sellDetails, // 4. SET clause parameters
                false // 5. isSimulation flag
            );

            if (!success) {
                elizaLogger.warn("Trade update returned false", {
                    tokenAddress,
                    recommenderId,
                    buyTimeStamp: trade.buy_timeStamp,
                });
            }

            elizaLogger.log("Trade performance update completed", {
                success,
                tokenAddress,
                recommenderId,
                profitPercent: profitPercent.toFixed(2) + "%",
                profitUsd: profitUsd.toFixed(4) + " USD",
            });
        } catch (dbError) {
            elizaLogger.error("Database error during trade update:", {
                error: dbError,
                query: {
                    sellDetails,
                    whereClause: {
                        tokenAddress,
                        recommenderId,
                        buyTimeStamp: trade.buy_timeStamp,
                    },
                },
            });
            throw dbError;
        }
    } catch (error) {
        elizaLogger.error("Failed to update trade performance:", {
            error,
            parameters: {
                sellDetails,
                whereClause: {
                    tokenAddress,
                    recommenderId,
                    buyTimeStamp: trade.buy_timeStamp,
                },
                originalTrade: trade,
            },
            errorDetails:
                error instanceof Error
                    ? {
                          message: error.message,
                          stack: error.stack,
                          name: error.name,
                      }
                    : error,
        });
        throw error;
    }

    return {
        sellDetails,
        currentPrice,
        profitDetails: {
            profitUsd,
            profitPercent,
            sellValueUsd,
        },
    };
}

// Update the module declaration to match the new parameter order
declare module "@elizaos/plugin-trustdb" {
    interface TrustScoreDatabase {
        updateTradePerformanceOnSell(
            tokenAddress: string, // Changed order: tokenAddress first
            recommenderId: string, // recommenderId second
            buyTimeStamp: string, // buyTimeStamp third
            sellDetails: SellDetailsData, // sellDetails fourth
            isSimulation: boolean // isSimulation fifth
        ): boolean;
    }
}

async function getChainBalance(
    connection: Connection,
    walletAddress: PublicKey,
    tokenAddress: string
): Promise<number> {
    // Use existing Solana balance fetching logic
    return await getTokenBalance(
        connection as any, // TODO: Resolve type conflict caused by multiple versions of @solana/web3.js
        walletAddress,
        new PublicKey(tokenAddress)
    );
}

async function createRabbiTraderPlugin(
    getSetting: (key: string) => string | undefined,
    runtime?: IAgentRuntime
): Promise<Plugin> {
    // Define resumeTrading at the start of the function
    const resumeTrading = async () => {
        // Load and analyze tokens
        const tokenAddresses = loadTokenAddresses().filter(
            (addr) => !addr.startsWith("0x")
        );
        elizaLogger.log(`Analyzing ${tokenAddresses.length} Solana tokens...`);

        // Analyze regular token list
        for (const tokenAddress of tokenAddresses) {
            await analyzeToken(
                runtime,
                connection,
                twitterService,
                tokenAddress
            );
        }

        // Add delay between iterations
        await new Promise((resolve) => setTimeout(resolve, 1200000)); // 20 minutes
    };

    elizaLogger.log("Starting GOAT plugin initialization");

    // Move connection initialization to the top
    const connection = new Connection(
        runtime?.getSetting("SOLANA_RPC_URL") ||
            "https://api.mainnet-beta.solana.com"
    );

    const keypair = getWalletKeypair(runtime);

    // Validate required settings
    const missingSettings: string[] = [];
    for (const [key, description] of Object.entries(REQUIRED_SETTINGS)) {
        if (!getSetting(key)) {
            missingSettings.push(`${key} (${description})`);
        }
    }

    if (missingSettings.length > 0) {
        const errorMsg = `Missing required settings: ${missingSettings.join(
            ", "
        )}`;
        elizaLogger.error(errorMsg);
        throw new Error(errorMsg);
    }

    elizaLogger.log("Initializing Solana connection...");
    const walletProvider: ExtendedWalletProvider = {
        connection,
        getChain: () => ({ type: "solana" }),
        getAddress: () => keypair.publicKey.toBase58(),
        signMessage: async (_message: string): Promise<Signature> => {
            throw new Error(
                "Message signing not implemented for Solana wallet"
            );
        },
        balanceOf: async (tokenAddress: string): Promise<ExtendedBalance> => {
            try {
                if (tokenAddress.startsWith("0x")) {
                    // Handle Base token balance
                    const baseBalance = await getChainBalance(
                        connection,
                        keypair.publicKey,
                        tokenAddress
                    );
                    return {
                        value: BigInt(baseBalance.toString()),
                        decimals: 18, // Base uses 18 decimals
                        formatted: (baseBalance / 1e18).toString(),
                        symbol: "ETH",
                        name: "Base",
                    };
                } else {
                    // Existing Solana logic
                    const tokenPublicKey = new PublicKey(tokenAddress);
                    const amount = await getTokenBalance(
                        connection as any, // TODO: Resolve type conflict caused by multiple versions of @solana/web3.js
                        keypair.publicKey,
                        tokenPublicKey
                    );
                    return {
                        value: BigInt(amount.toString()),
                        decimals: 9,
                        formatted: (amount / 1e9).toString(),
                        symbol: "SOL",
                        name: "Solana",
                    };
                }
            } catch {
                // do we want logging here?
                return {
                    value: BigInt(0),
                    decimals: tokenAddress.startsWith("0x") ? 18 : 9,
                    formatted: "0",
                    symbol: tokenAddress.startsWith("0x") ? "ETH" : "SOL",
                    name: tokenAddress.startsWith("0x") ? "Base" : "Solana",
                };
            }
        },
        getMaxBuyAmount: async (tokenAddress: string) => {
            try {
                if (tokenAddress.startsWith("0x")) {
                    // Handle Base chain balance
                    const baseBalance = await getChainBalance(
                        connection,
                        keypair.publicKey,
                        tokenAddress
                    );
                    return (baseBalance * 0.9) / 1e18; // Base uses 18 decimals
                } else {
                    // Handle Solana balance
                    const balance = await connection.getBalance(
                        keypair.publicKey
                    );
                    return (balance * 0.9) / 1e9; // Solana uses 9 decimals
                }
            } catch (error) {
                elizaLogger.error(
                    `Failed to get max buy amount for ${tokenAddress}:`,
                    error
                );
                return 0;
            }
        },
        executeTrade: async (_params) => {
            //try {
            return { success: true };
            //} catch (error) {
            //throw error;
            //}
        },
        getFormattedPortfolio: async () => "",
    };

    elizaLogger.log(
        "Solana connection and wallet provider initialized successfully"
    );

    // Initialize Twitter service if enabled
    let twitterService: TwitterService | undefined;
    try {
        elizaLogger.log(
            "Configuring Twitter service for trade notifications..."
        );
        const twitterConfig = TwitterConfigSchema.parse({
            enabled: getSetting("TWITTER_ENABLED") === "true",
            username: getSetting("TWITTER_USERNAME"),
            dryRun: false,
        });

        if (twitterConfig.enabled && runtime) {
            elizaLogger.log("Starting Twitter client initialization...");
            const twitterClient = await TwitterClientInterface.start(runtime);
            twitterService = new TwitterService(twitterClient, twitterConfig);

            // Add delay after initialization
            await new Promise((resolve) => setTimeout(resolve, 5000));

            elizaLogger.log("Twitter service initialized successfully", {
                username: twitterConfig.username,
                dryRun: twitterConfig.dryRun,
            });
        }
    } catch (error) {
        elizaLogger.error("Failed to initialize Twitter service:", error);
    }

    elizaLogger.log("Initializing Solana plugin components...");

    try {
        const customActions = actions;

        // Then update the plugin creation
        const plugin: ExtendedPlugin = {
            name: "[Rabbi Trader] Onchain Actions with Solana Integration",
            description: "Autonomous trading integration with AI analysis",
            evaluators: [trustEvaluator, ...(solanaPlugin.evaluators || [])],
            providers: [
                walletProvider,
                trustScoreProvider,
                ...(solanaPlugin.providers || []),
            ],
            actions: [...customActions, ...(solanaPlugin.actions || [])],
            services: [],
            autoStart: true,
        };

        // Add auto-start trading analysis
        if (!runtime) return;

        elizaLogger.log("Starting autonomous trading system...");
        const analyzeTradeAction = plugin.actions.find(
            (a) => a.name === "ANALYZE_TRADE"
        );

        if (!analyzeTradeAction) return;

        const interval =
            Number(runtime.getSetting("TRADING_INTERVAL")) || 300000;

        // Then start trading loop if enabled
        if (!settings.ENABLE_TRADING) return;

        elizaLogger.log("Initializing trading loop...");
        await resumeTrading();
        setInterval(resumeTrading, interval);

        elizaLogger.log("GOAT plugin initialization completed successfully");
        return plugin;
    } catch (error) {
        elizaLogger.error("Failed to initialize plugin components:", error);
        throw new Error(
            `Plugin initialization failed: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

async function analyzeToken(
    runtime: IAgentRuntime,
    connection: Connection,
    twitterService: TwitterService,
    tokenAddress: string
) {
    try {
        // Check cache first
        const cachedData: CacheEntry | undefined = tokenCache.get(tokenAddress);
        const now = Date.now();

        // Skip if analyzed within last 20 minutes
        if (cachedData && now - cachedData.lastAnalysis < 1200000) {
            elizaLogger.log(
                `Using cached data for ${tokenAddress}, last analyzed ${Math.floor(
                    (now - cachedData.lastAnalysis) / 1000
                )}s ago`
            );
            return;
        }

        elizaLogger.log(`Starting analysis for token: ${tokenAddress}`);

        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (!validateSolanaAddress(tokenAddress)) {
            elizaLogger.error(`Invalid token address format: ${tokenAddress}`);
            return;
        }

        // Initialize TokenProvider directly with just the token address
        const tokenProvider = new TokenProvider(tokenAddress);

        // Get processed token data which includes DexScreener data
        elizaLogger.log(`Fetching token data for ${tokenAddress}`);
        const tokenData = await tokenProvider.getProcessedTokenData();
        elizaLogger.log(`Token data fetched for ${tokenAddress}:`, tokenData);

        // Get trust score and cache it
        const trustProvider = new TrustScoreProvider();
        const trustEvaluation = await trustProvider.evaluateToken(tokenAddress);
        const { trustScore } = trustEvaluation;

        // Cache the new data
        const cacheEntry: CacheEntry = {
            lastAnalysis: Date.now(),
            tokenData,
            trustScore,
            analysisResult: null, // Will be updated after analysis
        };
        tokenCache.set(tokenAddress, cacheEntry);

        const walletPublicKey = runtime.getSetting("WALLET_PUBLIC_KEY");
        if (!walletPublicKey) {
            elizaLogger.error("No wallet public key configured");
            return;
        }

        /*
        const balance = await connection.getBalance(
            new PublicKey(walletPublicKey)
        );

        const walletSolBalance = {
            formatted: (balance / 1e9).toString(),
        };
        */

        // Initialize trustScoreDb
        const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);

        // Before creating analysisParams, get the latest trade performance
        const latestTrade = trustScoreDb.getLatestTradePerformance(
            tokenAddress,
            runtime.agentId,
            false // not simulation
        );

        elizaLogger.log(`Latest trade for ${tokenAddress}:`, latestTrade);

        // Before creating analysisParams, get the correct chain balance
        const walletBalance = await getChainWalletBalance(
            runtime,
            tokenAddress
        );

        const pair = tokenData.dexScreenerData.pairs[0];
        const analysisParams: AnalysisParams = {
            walletBalance, // Now using the correct chain's balance
            tokenAddress,
            price: Number(pair?.priceUsd || 0),
            volume: pair?.volume?.h24 || 0,
            marketCap: pair?.marketCap || 0,
            liquidity: pair?.liquidity?.usd || 0,
            holderDistribution: tokenData.holderDistributionTrend,
            trustScore: trustScore || 0,
            dexscreener: tokenData.dexScreenerData,
            position: latestTrade
                ? {
                      token_address: latestTrade.token_address,
                      entry_price: latestTrade.buy_price,
                      size: latestTrade.buy_amount,
                      stop_loss: latestTrade.buy_price * 0.85, // 15% stop loss
                      take_profit: latestTrade.buy_price * 1.3, // 30% take profit
                      open_timeStamp: latestTrade.buy_timeStamp,
                      status: latestTrade.sell_timeStamp ? "CLOSED" : "OPEN",
                  }
                : undefined,
        };

        // Create initial state first
        const state: State = await runtime.composeState({
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            content: {
                text: `Initialize state for ${tokenAddress}`,
                type: "analysis",
            },
        });

        // Then create analysis memory using state
        const analysisMemory: Memory = {
            userId: state.userId,
            agentId: runtime.agentId,
            roomId: state.roomId,
            content: {
                text: `Analyze trade for ${tokenAddress}`,
                type: "analysis",
            },
        };

        // Update analysis result in cache after completion
        const analysisResult = await analyzeTradeAction.handler(
            runtime,
            analysisMemory,
            state,
            analysisParams,
            async (response) => {
                if (!response) {
                    elizaLogger.error(
                        `Empty response from analysis for ${tokenAddress}`
                    );
                    return [];
                }

                elizaLogger.log(
                    `Analysis result for ${tokenAddress}:`,
                    response
                );
                try {
                    // Parse the JSON response from the analysis
                    const result =
                        typeof response.text === "string"
                            ? JSON.parse(response.text)
                            : response.text;

                    if (!result) {
                        elizaLogger.error(
                            `Invalid analysis result for ${tokenAddress}`
                        );

                        return [];
                    }

                    if (
                        result.shouldTrade &&
                        result.recommendedAction === "BUY"
                    ) {
                        await buy({
                            result,
                            runtime,
                            state,
                            tokenAddress,
                            tokenData,
                            twitterService,
                            trustScore,
                        });
                    } else if (result.recommendedAction === "SELL") {
                        await sell({
                            latestTrade,
                            result,
                            runtime,
                            state,
                            tokenAddress,
                            tokenProvider,
                            trustScoreDb,
                            twitterService,
                            trustScore,
                        });
                    } else {
                        elizaLogger.log(
                            `Trade not recommended for ${tokenAddress}:`,
                            result
                        );
                    }
                } catch (err) {
                    elizaLogger.error("rabbi - trade error", err);
                }
                return [];
            }
        );
        cacheEntry.analysisResult = analysisResult;
        tokenCache.set(tokenAddress, cacheEntry);
    } catch (tokenError) {
        elizaLogger.error(`Error processing token ${tokenAddress}:`, {
            error: tokenError,
            stack: tokenError instanceof Error ? tokenError.stack : undefined,
        });
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

async function buy({
    runtime,
    tokenAddress,
    state,
    tokenData,
    result,
    twitterService,
    trustScore,
}: {
    runtime: IAgentRuntime;
    tokenAddress: string;
    state: State;
    tokenData: ProcessedTokenData;
    result: any;
    twitterService: TwitterService;
    trustScore: number;
}) {
    elizaLogger.log(`Trade recommended for ${tokenAddress}:`, result);

    // Continue with simulation if analysis recommends trading
    const simulationService = new SimulationService();
    const simulation = await simulationService.simulateTrade(
        tokenAddress,
        result.suggestedAmount || SAFETY_LIMITS.MINIMUM_TRADE
    );

    if (simulation.recommendedAction === "EXECUTE") {
        try {
            // Check wallet balance before trade
            const currentBalance = await getWalletBalance(runtime);

            const tradeAmount = Math.min(
                result.suggestedAmount || SAFETY_LIMITS.MINIMUM_TRADE,
                currentBalance * 0.95 // Leave some SOL for fees
            );

            if (tradeAmount < SAFETY_LIMITS.MINIMUM_TRADE) {
                elizaLogger.warn(
                    `Insufficient balance for trade: ${currentBalance} SOL`
                );
            }

            // Create trade memory object
            const tradeMemory: Memory = {
                userId: state.userId,
                agentId: runtime.agentId,
                roomId: state.roomId,
                content: {
                    text: `Execute trade for ${tokenAddress}`,
                    tokenAddress,
                    amount: SAFETY_LIMITS.MINIMUM_TRADE,
                    action: "BUY",
                    source: "system",
                    type: "trade",
                },
            };

            // Execute trade using our custom function
            const tradeResult = await executeTrade(runtime, {
                tokenAddress,
                amount: tradeAmount,
                slippage: tokenAddress.startsWith("0x") ? 0.03 : 0.3, // 3% for Base, 30% for Solana
                chain: tokenAddress.startsWith("0x") ? "base" : "solana",
            });

            if (tradeResult.success) {
                elizaLogger.log(
                    `Trade executed successfully for ${tokenAddress}:`,
                    {
                        signature: tradeResult.signature,
                        amount: tradeAmount,
                        memory: tradeMemory,
                    }
                );

                // Check rate limit before tweeting
                if (twitterService && result.recommendedAction === "BUY") {
                    await tweetTrade(twitterService, {
                        token:
                            tokenData.dexScreenerData.pairs[0]?.baseToken
                                ?.symbol || tokenAddress,
                        tokenAddress: tokenAddress,
                        amount: tradeAmount,
                        trustScore: Number(trustScore) || 0,
                        riskLevel: result.riskLevel || "MEDIUM",
                        marketData: {
                            priceChange24h:
                                tokenData.dexScreenerData.pairs[0]?.priceChange
                                    ?.h24 || 0,
                            volume24h:
                                tokenData.dexScreenerData.pairs[0]?.volume
                                    ?.h24 || 0,
                            liquidity: {
                                usd:
                                    tokenData.dexScreenerData.pairs[0]
                                        ?.liquidity?.usd || 0,
                            },
                        },
                        timestamp: Date.now(),
                        signature: tradeResult.signature,
                        hash: tradeResult.hash,
                        action: "BUY",
                        price: Number(
                            tokenData.dexScreenerData.pairs[0]?.priceUsd || 0
                        ),
                    });
                } else {
                    elizaLogger.log("Skipping tweet due to rate limit");
                }

                // Record trade using TrustScoreDatabase methods
                const trustScoreDb = new TrustScoreDatabase(
                    runtime.databaseAdapter.db
                );

                try {
                    // Remove the PublicKey validation for Base addresses
                    elizaLogger.log(
                        `Attempting to validate token address: ${tokenAddress}`
                    );
                    const formattedAddress = tokenAddress.startsWith("0x")
                        ? tokenAddress
                        : new PublicKey(tokenAddress).toBase58(); // Only convert Solana addresses
                    elizaLogger.log(
                        `Token address validated successfully: ${formattedAddress}`
                    );

                    // Create a new recommender ID for this trade
                    const uuid = uuidv4();
                    const recommender =
                        await trustScoreDb.getOrCreateRecommender({
                            id: uuid,
                            address: "",
                            solanaPubkey:
                                runtime.getSetting("WALLET_PUBLIC_KEY") || "",
                        });
                    elizaLogger.log(`Created/retrieved recommender:`, {
                        recommender,
                        chainType: tokenAddress.startsWith("0x")
                            ? "base"
                            : "solana",
                    });

                    // Prepare trade data
                    const tradeData = {
                        buy_amount: tradeAmount,
                        is_simulation: false,
                        token_address: new PublicKey(tokenAddress).toBase58(),
                        buy_price:
                            tokenData.dexScreenerData.pairs[0]?.priceUsd || 0,
                        buy_timeStamp: new Date().toISOString(),
                        buy_market_cap:
                            tokenData.dexScreenerData.pairs[0]?.marketCap || 0,
                        buy_liquidity:
                            tokenData.dexScreenerData.pairs[0]?.liquidity
                                ?.usd || 0,
                        buy_value_usd:
                            tradeAmount *
                            Number(
                                tokenData.dexScreenerData.pairs[0]?.priceUsd ||
                                    0
                            ),
                    };
                    elizaLogger.log(`Prepared trade data:`, tradeData);

                    // Create trade record directly using trustScoreDb
                    await trustScoreDb.addTradePerformance(
                        {
                            token_address: formattedAddress, // Use the properly formatted address
                            recommender_id: recommender.id,
                            buy_price: Number(tradeData.buy_price),
                            buy_timeStamp: tradeData.buy_timeStamp,
                            buy_amount: tradeData.buy_amount,
                            buy_value_usd: tradeData.buy_value_usd,
                            buy_market_cap: tradeData.buy_market_cap,
                            buy_liquidity: tradeData.buy_liquidity,
                            buy_sol: tradeAmount,
                            last_updated: new Date().toISOString(),
                            sell_price: 0,
                            sell_timeStamp: "",
                            sell_amount: 0,
                            received_sol: 0,
                            sell_value_usd: 0,
                            sell_market_cap: 0,
                            sell_liquidity: 0,
                            profit_usd: 0,
                            profit_percent: 0,
                            market_cap_change: 0,
                            liquidity_change: 0,
                            rapidDump: false,
                        },
                        false
                    );

                    elizaLogger.log(
                        `Successfully recorded trade performance for ${tokenAddress}`
                    );
                } catch (error) {
                    elizaLogger.error("Failed to record trade performance:", {
                        error,
                        tokenAddress,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                        errorType: error?.constructor?.name,
                    });
                }
            } else {
                elizaLogger.error(
                    `Trade execution failed for ${tokenAddress}:`,
                    tradeResult.error
                );
            }
        } catch (tradeError) {
            elizaLogger.error(
                `Error during trade execution for ${tokenAddress}:`,
                {
                    error: tradeError,
                    stack:
                        tradeError instanceof Error
                            ? tradeError.stack
                            : undefined,
                }
            );
        }
    } else {
        elizaLogger.log(
            `Simulation rejected trade for ${tokenAddress}:`,
            simulation
        );
    }
}

async function sell({
    // eslint-disable-next-line
    state,
    runtime,
    tokenAddress,
    tokenProvider,
    twitterService,
    trustScoreDb,
    latestTrade,
    result,
    trustScore,
}: {
    state: State;
    runtime: IAgentRuntime;
    tokenAddress: string;
    tokenProvider: TokenProvider;
    twitterService: TwitterService;
    trustScoreDb: TrustScoreDatabase;
    result: any;
    latestTrade: TradePerformance;
    trustScore: number;
}) {
    // Get the trade amount from the latest trade
    const tradeAmount = Number(latestTrade?.buy_amount || 0);

    /*
    // Create and save trade memory object for sell
    const tradeMemory: Memory = {
        userId: state.userId,
        agentId: runtime.agentId,
        roomId: state.roomId,
        content: {
            text: `Execute sell for ${tokenAddress}`,
            tokenAddress,
            amount: tradeAmount,
            action: "SELL",
            source: "system",
            type: "trade",
        },
    };
    */

    // Execute sell trade
    const tradeResult = await executeTrade(runtime, {
        tokenAddress,
        amount: tradeAmount,
        slippage: 0.3, //  30% for Solana
        chain: "solana",
    });

    if (tradeResult.success) {
        elizaLogger.log(`Sell executed successfully for ${tokenAddress}:`, {
            signature: tradeResult.signature,
            amount: tradeAmount,
        });

        // Get token data first
        const tokenData = await tokenProvider.getProcessedTokenData();

        // Create recommender
        const uuid = uuidv4();
        const recommender = await trustScoreDb.getOrCreateRecommender({
            id: uuid,
            address: "", // Empty since we're only handling Solana
            solanaPubkey: runtime.getSetting("WALLET_PUBLIC_KEY") || "",
        });

        // Update sell details and get prices
        const { sellDetails, currentPrice } = await updateSellDetails(
            runtime,
            tokenAddress,
            recommender.id,
            tradeAmount,
            latestTrade,
            tokenData
        );

        // Post tweet if enabled
        if (twitterService) {
            await tweetTrade(twitterService, {
                token:
                    tokenData.dexScreenerData.pairs[0]?.baseToken?.symbol ||
                    tokenAddress,
                tokenAddress: tokenAddress,
                amount: tradeAmount,
                trustScore: Number(trustScore) || 0,
                riskLevel: result.riskLevel || "MEDIUM",
                marketData: {
                    priceChange24h:
                        tokenData.dexScreenerData.pairs[0]?.priceChange?.h24 ||
                        0,
                    volume24h:
                        tokenData.dexScreenerData.pairs[0]?.volume?.h24 || 0,
                    liquidity: {
                        usd:
                            tokenData.dexScreenerData.pairs[0]?.liquidity
                                ?.usd || 0,
                    },
                },
                timestamp: Date.now(),
                signature: tradeResult.signature,
                hash: tradeResult.hash,
                action: "SELL",
                price: Number(currentPrice),
                profitPercent: `${sellDetails.profit_percent.toFixed(2)}%`,
                profitUsd: `${sellDetails.profit_usd.toFixed(4)} USD`,
                reason: `P/L: ${sellDetails.profit_percent.toFixed(2)}%`,
            });
        }

        elizaLogger.log(
            `Successfully updated sell details for ${tokenAddress}`,
            {
                sellPrice: currentPrice,
                sellAmount: tradeAmount,
            }
        );
    } else {
        elizaLogger.error(
            `Sell execution failed for ${tokenAddress}:`,
            tradeResult.error
        );
    }
}

export default createRabbiTraderPlugin;
