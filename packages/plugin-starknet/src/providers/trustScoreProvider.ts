import type { ProcessedTokenData, TokenSecurityData } from "../types/trustDB.ts";
// import { Connection, PublicKey } from "@solana/web3.js";
// import { getAssociatedTokenAddress } from "@solana/spl-token";
// import { TokenProvider } from "./token.ts";
import {
    elizaLogger,
    type IAgentRuntime,
    type Memory,
    type Provider,
    settings,
    type State,
} from "@elizaos/core";
import {
    type RecommenderMetrics,
    type TokenPerformance,
    type TokenRecommendation,
    type TradePerformance,
    TrustScoreDatabase,
} from "@elizaos/plugin-trustdb";
import { getTokenBalance } from "../utils/index.ts";
import type { TokenProvider } from "./token.ts";
import { WalletProvider } from "./portfolioProvider.ts";

const _Wallet = settings.MAIN_WALLET_ADDRESS;
interface TradeData {
    buy_amount: number;
    is_simulation: boolean;
}
interface sellDetails {
    sell_amount: number;
    sell_recommender_id: string | null;
}
// Fix: Replace explicit any with proper type
interface Recommendation {
    // Add actual properties based on usage
    score: number;
    // ... other properties
}

interface _RecommendationGroup {
    recommendation: Recommendation;
    trustScore: number;
}

interface RecommenderData {
    recommenderId: string;
    trustScore: number;
    riskScore: number;
    consistencyScore: number;
    recommenderMetrics: RecommenderMetrics;
}

interface TokenRecommendationSummary {
    tokenAddress: string;
    averageTrustScore: number;
    averageRiskScore: number;
    averageConsistencyScore: number;
    recommenders: RecommenderData[];
}
export class TrustScoreManager {
    private tokenProvider: TokenProvider;
    private trustScoreDb: TrustScoreDatabase;
    private DECAY_RATE = 0.95;
    private MAX_DECAY_DAYS = 30;
    private backend;
    private backendToken;
    private runtime: IAgentRuntime;
    constructor(
        runtime: IAgentRuntime,
        tokenProvider: TokenProvider,
        trustScoreDb: TrustScoreDatabase
    ) {
        this.tokenProvider = tokenProvider;
        this.trustScoreDb = trustScoreDb;

        // TODO: change to starknet
        this.backend = runtime.getSetting("BACKEND_URL");

        // TODO: change to starknet
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");

        this.runtime = runtime;
    }

    // Get Recommender Balance
    async getRecommenderBalance(recommenderWallet: string): Promise<number> {
        try {
            const tokenBalance = await getTokenBalance(
                this.runtime,
                recommenderWallet
            );
            const balance = Number.parseFloat(tokenBalance);
            return balance;
        } catch (error) {
            elizaLogger.error("Error fetching balance", error);
            return 0;
        }
    }

    /**
     * Generates and saves trust score based on processed token data and user recommendations.
     * @param tokenAddress The address of the token to analyze.
     * @param recommenderId The UUID of the recommender.
     * @returns An object containing TokenPerformance and RecommenderMetrics.
     */
    async generateTrustScore(
        tokenAddress: string,
        recommenderId: string,
        recommenderWallet: string
    ): Promise<{
        tokenPerformance: TokenPerformance;
        recommenderMetrics: RecommenderMetrics;
    }> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        elizaLogger.log(
            `Fetched processed token data for token: ${tokenAddress}`
        );

        const recommenderMetrics =
            await this.trustScoreDb.getRecommenderMetrics(recommenderId);

        const isRapidDump = await this.isRapidDump(tokenAddress);
        const sustainedGrowth = await this.sustainedGrowth(tokenAddress);
        const suspiciousVolume = await this.suspiciousVolume(tokenAddress);
        const balance = await this.getRecommenderBalance(recommenderWallet);
        const virtualConfidence = balance / 1000000; // TODO: create formula to calculate virtual confidence based on user balance
        const lastActive = recommenderMetrics.lastActiveDate;
        const now = new Date();
        const inactiveDays = Math.floor(
            (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
        );
        // const decayFactor = Math.pow(
        //     this.DECAY_RATE,
        //     Math.min(inactiveDays, this.MAX_DECAY_DAYS)
        // );
        // Fix: Replace Math.pow with ** operator
        const decayFactor = this.DECAY_RATE ** Math.min(inactiveDays, this.MAX_DECAY_DAYS);

        const decayedScore = recommenderMetrics.trustScore * decayFactor;
        const validationTrustScore =
            this.trustScoreDb.calculateValidationTrust(tokenAddress);

        return {
            tokenPerformance: {
                tokenAddress:
                    processedData.dexScreenerData.pairs[0]?.baseToken.address ||
                    "",
                symbol: processedData.dexScreenerData.pairs[0]?.baseToken.symbol || "",
                balance: 0, // TODO: Implement balance check
                initialMarketCap: processedData.dexScreenerData.pairs[0]?.marketCap || 0,
                priceChange24h:
                    processedData.tradeData.market.priceChangePercentage24h,
                volumeChange24h: processedData.tradeData.market.starknetVolume24h,
                trade_24h_change:
                    processedData.tradeData.market.starknetTradingVolume24h,
                liquidity:
                    processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
                liquidityChange24h: 0,
                holderChange24h:
                    processedData.tradeData.market.starknetTradingVolume24h,
                rugPull: false, // TODO: Implement rug pull detection
                isScam: false, // TODO: Implement scam detection
                marketCapChange24h: 0, // TODO: Implement market cap change
                sustainedGrowth: sustainedGrowth,
                rapidDump: isRapidDump,
                suspiciousVolume: suspiciousVolume,
                validationTrust: validationTrustScore,
                lastUpdated: new Date(),
            },
            recommenderMetrics: {
                recommenderId: recommenderId,
                trustScore: recommenderMetrics.trustScore,
                totalRecommendations: recommenderMetrics.totalRecommendations,
                successfulRecs: recommenderMetrics.successfulRecs,
                avgTokenPerformance: recommenderMetrics.avgTokenPerformance,
                riskScore: recommenderMetrics.riskScore,
                consistencyScore: recommenderMetrics.consistencyScore,
                virtualConfidence: virtualConfidence,
                lastActiveDate: now,
                trustDecay: decayedScore,
                lastUpdated: new Date(),
            },
        };
    }

    async updateRecommenderMetrics(
        recommenderId: string,
        tokenPerformance: TokenPerformance,
        recommenderWallet: string
    ): Promise<void> {
        const recommenderMetrics =
            await this.trustScoreDb.getRecommenderMetrics(recommenderId);

        const totalRecommendations =
            recommenderMetrics.totalRecommendations + 1;
        const successfulRecs = tokenPerformance.rugPull
            ? recommenderMetrics.successfulRecs
            : recommenderMetrics.successfulRecs + 1;
        const avgTokenPerformance =
            (recommenderMetrics.avgTokenPerformance *
                recommenderMetrics.totalRecommendations +
                tokenPerformance.priceChange24h) /
            totalRecommendations;

        const overallTrustScore = this.calculateTrustScore(
            tokenPerformance,
            recommenderMetrics
        );
        const riskScore = this.calculateOverallRiskScore(
            tokenPerformance,
            recommenderMetrics
        );
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        const balance = await this.getRecommenderBalance(recommenderWallet);
        const virtualConfidence = balance / 1000000; // TODO: create formula to calculate virtual confidence based on user balance
        const lastActive = recommenderMetrics.lastActiveDate;
        const now = new Date();
        const inactiveDays = Math.floor(
            (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24)
        );
        // const decayFactor = Math.pow(
        //     this.DECAY_RATE,
        //     Math.min(inactiveDays, this.MAX_DECAY_DAYS)
        // );
        // Fix: Replace Math.pow with ** operator
        const decayFactor = this.DECAY_RATE ** Math.min(inactiveDays, this.MAX_DECAY_DAYS);

        const decayedScore = recommenderMetrics.trustScore * decayFactor;

        const newRecommenderMetrics: RecommenderMetrics = {
            recommenderId: recommenderId,
            trustScore: overallTrustScore,
            totalRecommendations: totalRecommendations,
            successfulRecs: successfulRecs,
            avgTokenPerformance: avgTokenPerformance,
            riskScore: riskScore,
            consistencyScore: consistencyScore,
            virtualConfidence: virtualConfidence,
            lastActiveDate: new Date(),
            trustDecay: decayedScore,
            lastUpdated: new Date(),
        };

        await this.trustScoreDb.updateRecommenderMetrics(newRecommenderMetrics);
    }

    calculateTrustScore(
        tokenPerformance: TokenPerformance,
        recommenderMetrics: RecommenderMetrics
    ): number {
        const riskScore = this.calculateRiskScore(tokenPerformance);
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        return (riskScore + consistencyScore) / 2;
    }

    calculateOverallRiskScore(
        tokenPerformance: TokenPerformance,
        recommenderMetrics: RecommenderMetrics
    ) {
        const riskScore = this.calculateRiskScore(tokenPerformance);
        const consistencyScore = this.calculateConsistencyScore(
            tokenPerformance,
            recommenderMetrics
        );

        return (riskScore + consistencyScore) / 2;
    }

    calculateRiskScore(tokenPerformance: TokenPerformance): number {
        let riskScore = 0;
        if (tokenPerformance.rugPull) {
            riskScore += 10;
        }
        if (tokenPerformance.isScam) {
            riskScore += 10;
        }
        if (tokenPerformance.rapidDump) {
            riskScore += 5;
        }
        if (tokenPerformance.suspiciousVolume) {
            riskScore += 5;
        }
        return riskScore;
    }

    calculateConsistencyScore(
        tokenPerformance: TokenPerformance,
        recommenderMetrics: RecommenderMetrics
    ): number {
        const avgTokenPerformance = recommenderMetrics.avgTokenPerformance;
        const priceChange24h = tokenPerformance.priceChange24h;

        return Math.abs(priceChange24h - avgTokenPerformance);
    }

    async suspiciousVolume(tokenAddress: string): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        const unique_wallet_24h = processedData.tradeData.market.starknetTradingVolume24h;
        const volume_24h = processedData.tradeData.market.starknetVolume24h;
        const suspiciousVolume = unique_wallet_24h / volume_24h > 0.5;
        elizaLogger.log(
            `Fetched processed token data for token: ${tokenAddress}`
        );
        return suspiciousVolume;
    }

    async sustainedGrowth(tokenAddress: string): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        elizaLogger.log(
            `Fetched processed token data for token: ${tokenAddress}`
        );

        // Use starknetTradingVolume24h as a proxy for volume growth
        const currentVolume = processedData.tradeData.market.starknetTradingVolume24h;

        // Define a growth threshold (e.g., $1M volume as sustained growth)
        const growthThreshold = 1_000_000;

        return currentVolume > growthThreshold;
    }

    async isRapidDump(tokenAddress: string): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        elizaLogger.log(
            `Fetched processed token data for token: ${tokenAddress}`
        );

        // Use priceChangePercentage24h as a proxy for rapid dump
        const priceChange24h = processedData.tradeData.market.priceChangePercentage24h;

        // Consider a rapid dump if the price drops more than 50% in 24 hours
        return priceChange24h < -50;
    }

    async checkTrustScore(tokenAddress: string): Promise<TokenSecurityData> {
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();
        elizaLogger.log(
            `Fetched processed token data for token: ${tokenAddress}`
        );

        return {
            ownerBalance: processedData.security.ownerBalance,
            creatorBalance: processedData.security.creatorBalance,
            ownerPercentage: processedData.security.ownerPercentage,
            creatorPercentage: processedData.security.creatorPercentage,
            top10HolderBalance: processedData.security.top10HolderBalance,
            top10HolderPercent: processedData.security.top10HolderPercent,
        };
    }

    /**
     * Creates a TradePerformance object based on token data and recommender.
     * @param tokenAddress The address of the token.
     * @param recommenderId The UUID of the recommender.
     * @param data ProcessedTokenData.
     * @returns TradePerformance object.
     */
    async createTradePerformance(
        runtime: IAgentRuntime,
        tokenAddress: string,
        recommenderId: string,
        data: TradeData
    ): Promise<TradePerformance> {
        const recommender =
            await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
                recommenderId
            );
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();

        // TODO: change to starknet
        const wallet = new WalletProvider(runtime);

        const prices = await wallet.getTokenUsdValues();
        const solPrice = prices.solana?.usd;
        if (!solPrice) {
            throw new Error("Unable to fetch Solana price (cryptoName: 'solana').");
        }
        const buySol = data.buy_amount / solPrice;
        const buy_value_usd = data.buy_amount * processedData.tradeData.market.currentPrice;

        const creationData = {
            token_address: tokenAddress,
            recommender_id: recommender.id,
            buy_price: processedData.tradeData.market.currentPrice,
            sell_price: 0,
            buy_timeStamp: new Date().toISOString(),
            sell_timeStamp: "",
            buy_amount: data.buy_amount,
            sell_amount: 0,
            buy_sol: buySol,
            received_sol: 0,
            buy_value_usd: buy_value_usd,
            sell_value_usd: 0,
            profit_usd: 0,
            profit_percent: 0,
            buy_market_cap:
                processedData.dexScreenerData.pairs[0]?.marketCap || 0,
            sell_market_cap: 0,
            market_cap_change: 0,
            buy_liquidity:
                processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0,
            sell_liquidity: 0,
            liquidity_change: 0,
            last_updated: new Date().toISOString(),
            rapidDump: false,
        };
        this.trustScoreDb.addTradePerformance(creationData, data.is_simulation);
        // api call to update trade performance
        this.createTradeInBe(tokenAddress, recommenderId, data);
        return creationData;
    }

    async delay(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // TODO: change to starknet
    async createTradeInBe(
        tokenAddress: string,
        recommenderId: string,
        data: TradeData,
        retries = 3,
        delayMs = 2000
    ) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await fetch(
                    `${this.backend}/api/updaters/createTradePerformance`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${this.backendToken}`,
                        },
                        body: JSON.stringify({
                            tokenAddress: tokenAddress,
                            tradeData: data,
                            recommenderId: recommenderId,
                        }),
                    }
                );
                // If the request is successful, exit the loop
                return;
            } catch (error) {
                elizaLogger.error(
                    `Attempt ${attempt} failed: Error creating trade in backend`,
                    error
                );
                if (attempt < retries) {
                    elizaLogger.log(`Retrying in ${delayMs} ms...`);
                    await this.delay(delayMs); // Wait for the specified delay before retrying
                } else {
                    elizaLogger.error("All attempts failed.");
                }
            }
        }
    }

    /**
     * Updates a trade with sell details.
     * @param tokenAddress The address of the token.
     * @param recommenderId The UUID of the recommender.
     * @param buyTimeStamp The timestamp when the buy occurred.
     * @param sellDetails An object containing sell-related details.
     * @param isSimulation Whether the trade is a simulation. If true, updates in simulation_trade; otherwise, in trade.
     * @returns boolean indicating success.
     */

    async updateSellDetails(
        _runtime: IAgentRuntime,
        tokenAddress: string,
        recommenderId: string,
        sellTimeStamp: string,
        sellDetails: sellDetails,
        isSimulation: boolean
    ) {
        const recommender =
            await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
                recommenderId
            );
        const processedData: ProcessedTokenData =
            await this.tokenProvider.getProcessedTokenData();

        // TODO:
        const wallet = new WalletProvider(this.runtime);

        const prices = await wallet.getTokenUsdValues();
        const solPrice = prices.solana?.usd;
        if (!solPrice) {
            throw new Error("Unable to fetch Solana price (cryptoName: 'solana').");
        }
        const sellSol = sellDetails.sell_amount / solPrice;
        const sell_value_usd =
            sellDetails.sell_amount * processedData.tradeData.market.currentPrice;
        const trade = await this.trustScoreDb.getLatestTradePerformance(
            tokenAddress,
            recommender.id,
            isSimulation
        );
        const buyTimeStamp = trade.buy_timeStamp;
        const marketCap =
            processedData.dexScreenerData.pairs[0]?.marketCap || 0;
        const liquidity =
            processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0;
        const sell_price = processedData.tradeData.market.currentPrice;
        const profit_usd = sell_value_usd - trade.buy_value_usd;
        const profit_percent = (profit_usd / trade.buy_value_usd) * 100;

        const market_cap_change = marketCap - trade.buy_market_cap;
        const liquidity_change = liquidity - trade.buy_liquidity;

        const isRapidDump = await this.isRapidDump(tokenAddress);

        const sellDetailsData = {
            sell_price: sell_price,
            sell_timeStamp: sellTimeStamp,
            sell_amount: sellDetails.sell_amount,
            received_sol: sellSol,
            sell_value_usd: sell_value_usd,
            profit_usd: profit_usd,
            profit_percent: profit_percent,
            sell_market_cap: marketCap,
            market_cap_change: market_cap_change,
            sell_liquidity: liquidity,
            liquidity_change: liquidity_change,
            rapidDump: isRapidDump,
            sell_recommender_id: sellDetails.sell_recommender_id || null,
        };
        this.trustScoreDb.updateTradePerformanceOnSell(
            tokenAddress,
            recommender.id,
            buyTimeStamp,
            sellDetailsData,
            isSimulation
        );
        return sellDetailsData;
    }

    // get all recommendations
    async getRecommendations(
        startDate: Date,
        endDate: Date
    ): Promise<Array<TokenRecommendationSummary>> {
        const recommendations = this.trustScoreDb.getRecommendationsByDateRange(
            startDate,
            endDate
        );

        // Group recommendations by tokenAddress
        const groupedRecommendations = recommendations.reduce(
            (acc, recommendation) => {
                const { tokenAddress } = recommendation;
                if (!acc[tokenAddress]) acc[tokenAddress] = [];
                acc[tokenAddress].push(recommendation);
                return acc;
            },
            {} as Record<string, Array<TokenRecommendation>>
        );

        // const result = Object.keys(groupedRecommendations).map(
        //     (tokenAddress) => {
        //         const tokenRecommendations =
        //             groupedRecommendations[tokenAddress];

        //         // Initialize variables to compute averages
        //         let totalTrustScore = 0;
        //         let totalRiskScore = 0;
        //         let totalConsistencyScore = 0;
        //         const recommenderData = [];

        //         tokenRecommendations.forEach((recommendation) => {
        //             const tokenPerformance =
        //                 this.trustScoreDb.getTokenPerformance(
        //                     recommendation.tokenAddress
        //                 );
        //             const recommenderMetrics =
        //                 this.trustScoreDb.getRecommenderMetrics(
        //                     recommendation.recommenderId
        //                 );

        //             const trustScore = this.calculateTrustScore(
        //                 tokenPerformance,
        //                 recommenderMetrics
        //             );
        //             const consistencyScore = this.calculateConsistencyScore(
        //                 tokenPerformance,
        //                 recommenderMetrics
        //             );
        //             const riskScore = this.calculateRiskScore(tokenPerformance);

        //             // Accumulate scores for averaging
        //             totalTrustScore += trustScore;
        //             totalRiskScore += riskScore;
        //             totalConsistencyScore += consistencyScore;

        //             recommenderData.push({
        //                 recommenderId: recommendation.recommenderId,
        //                 trustScore,
        //                 riskScore,
        //                 consistencyScore,
        //                 recommenderMetrics,
        //             });
        //         });


        const result = Object.keys(groupedRecommendations).map(
            (tokenAddress) => {
                const tokenRecommendations = groupedRecommendations[tokenAddress];
        
                // Initialize variables to compute averages
                let totalTrustScore = 0;
                let totalRiskScore = 0;
                let totalConsistencyScore = 0;
                const recommenderData = [];
        
                // Changed from forEach to for...of
                for (const recommendation of tokenRecommendations) {
                    const tokenPerformance = this.trustScoreDb.getTokenPerformance(
                        recommendation.tokenAddress
                    );
                    const recommenderMetrics = this.trustScoreDb.getRecommenderMetrics(
                        recommendation.recommenderId
                    );
        
                    const trustScore = this.calculateTrustScore(
                        tokenPerformance,
                        recommenderMetrics
                    );
                    const consistencyScore = this.calculateConsistencyScore(
                        tokenPerformance,
                        recommenderMetrics
                    );
                    const riskScore = this.calculateRiskScore(tokenPerformance);
        
                    // Accumulate scores for averaging
                    totalTrustScore += trustScore;
                    totalRiskScore += riskScore;
                    totalConsistencyScore += consistencyScore;
        
                    recommenderData.push({
                        recommenderId: recommendation.recommenderId,
                        trustScore,
                        riskScore,
                        consistencyScore,
                        recommenderMetrics,
                    });
                }

                // Calculate averages for this token
                const averageTrustScore =
                    totalTrustScore / tokenRecommendations.length;
                const averageRiskScore =
                    totalRiskScore / tokenRecommendations.length;
                const averageConsistencyScore =
                    totalConsistencyScore / tokenRecommendations.length;

                return {
                    tokenAddress,
                    averageTrustScore,
                    averageRiskScore,
                    averageConsistencyScore,
                    recommenders: recommenderData,
                };
            }
        );

        // Sort recommendations by the highest average trust score
        result.sort((a, b) => b.averageTrustScore - a.averageTrustScore);

        return result;
    }
}

export const trustScoreProvider: Provider = {
    async get(
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string> {
        try {
            // if the database type is postgres, we don't want to run this evaluator because it relies on sql queries that are currently specific to sqlite. This check can be removed once the trust score provider is updated to work with postgres.
            if (runtime.getSetting("POSTGRES_URL")) {
                elizaLogger.warn(
                    "skipping trust evaluator because db is postgres"
                );
                return "";
            }

            const trustScoreDb = new TrustScoreDatabase(
                runtime.databaseAdapter.db
            );

            // Get the user ID from the message
            const userId = message.userId;

            if (!userId) {
                elizaLogger.error("User ID is missing from the message");
                return "";
            }

            // Get the recommender metrics for the user
            const recommenderMetrics =
                await trustScoreDb.getRecommenderMetrics(userId);

            if (!recommenderMetrics) {
                elizaLogger.error(
                    "No recommender metrics found for user:",
                    userId
                );
                return "";
            }

            // Compute the trust score
            const trustScore = recommenderMetrics.trustScore;

            const user = await runtime.databaseAdapter.getAccountById(userId);

            // Format the trust score string
            const trustScoreString = `${
                user.name
            }'s trust score: ${trustScore.toFixed(2)}`;

            return trustScoreString;
        } catch (error) {
            elizaLogger.error("Error in trust score provider:", error.message);
            return `Failed to fetch trust score: ${
                error instanceof Error ? error.message : "Unknown error"
            }`;
        }
    },
};
