/**
 * This module provides functionality to fetch and manage stake pool information from various protocols
 * including Marinade, Jito, Blaze, MarginFi, and JPool.
 */
import { elizaLogger, Provider } from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";
import NodeCache from "node-cache";
import { stakePoolInfo } from "@solana/spl-stake-pool";
import { MarinadeUtils, BN } from "@marinade.finance/marinade-ts-sdk";
import { STAKE_POOLS } from "../actions/liquidStake";
import { StakePoolInfo, StakeProtocolData } from "../types/stake";

// Provider configuration for retry mechanism and caching
const PROVIDER_CONFIG = {
    MAX_RETRIES: 3,        // Maximum number of retry attempts for failed requests
    RETRY_DELAY: 2000,     // Delay between retries in milliseconds
    CACHE_TTL: 300,        // Cache time-to-live in seconds (5 minutes)
};

// Utility function to introduce delay
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Class responsible for fetching and managing stake pool information
 * Implements caching and retry mechanisms for reliable data fetching
 */
export class StakeProtocolProvider {
    private cache: NodeCache;

    constructor(private connection: Connection) {
        this.cache = new NodeCache({ stdTTL: PROVIDER_CONFIG.CACHE_TTL });
    }

    /**
     * Fetches data from a URL with retry mechanism
     * @param url - The URL to fetch data from
     * @param options - Optional fetch configuration
     * @returns Promise resolving to the parsed JSON response
     */
    private async fetchWithRetry(
        url: string,
        options: RequestInit = {}
    ): Promise<any> {
        let lastError: any;
        for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
            try {
                const response = await fetch(url, options);
                if (!response.ok) {
                    elizaLogger.error("HTTP error:", response);
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return await response.json();
            } catch (error) {
                lastError = error;
                elizaLogger.error("Error fetching data:", error);
                await new Promise((resolve) =>
                    setTimeout(resolve, PROVIDER_CONFIG.RETRY_DELAY)
                );
            }
        }
        throw lastError;
    }

    /**
     * Fetches comprehensive pool data from all supported protocols
     * Implements caching to avoid frequent API calls
     * @returns Promise<StakeProtocolData> containing pool information and timestamp
     */
    private async fetchPoolData(): Promise<StakeProtocolData> {
        const cacheKey = "stake_pool_data";
        const cachedData = this.cache.get<StakeProtocolData>(cacheKey);

        if (cachedData) {
            return cachedData;
        }

        const pools: Record<string, StakePoolInfo> = {};

        // Fetch data for each pool
        for (const [key, pool] of Object.entries(STAKE_POOLS)) {
            try {
                let apy = 0;
                let tvl = 0;
                if (pool.protocolName === "Marinade") {
                    // Marinade uses dedicated API endpoints for APY and TVL
                    const apyData = await this.fetchWithRetry(
                        "https://apy.marinade.finance/marinade"
                    );
                    const tvlData = await this.fetchWithRetry(
                        "https://api.marinade.finance/tlv"
                    );
                    tvl = tvlData.total_sol;
                    apy = apyData.apy * 100;
                } else {
                    // For other protocols, fetch base pool info from Solana
                    const poolAddr = new PublicKey(pool.address);
                    const poolInfo = await stakePoolInfo(
                        this.connection,
                        poolAddr
                    );
                    tvl = MarinadeUtils.lamportsToSol(
                        new BN(poolInfo.totalLamports)
                    );
                    // Protocol-specific APY calculations
                    switch (pool.protocolName.toLowerCase()) {
                        case "jito": {
                            const apyData = await this.fetchWithRetry(
                                "https://www.jito.network/api/getJitoPoolStatsRecentOnly"
                            );
                            apy = apyData.latestApy;
                            break;
                        }
                        case "blaze": {
                            const apyData = await this.fetchWithRetry(
                                "https://stake.solblaze.org/api/v1/apy"
                            );
                            apy = apyData.apy;
                            break;
                        }
                        case "marginfi": {
                            const apyData = await this.fetchWithRetry(
                                "https://app.marginfi.com/api/lst"
                            );
                            apy = apyData.data.apy;
                            break;
                        }
                        case "jpool": {
                            const baseData = await this.fetchWithRetry(
                                "https://stake.solblaze.org/api/v1/apy"
                            );
                            const jpoolData = await this.fetchWithRetry(
                                "https://api2.jpool.one/direct-stake/strategy/stats?strategy=20&build=0.2.55"
                            );
                            apy = baseData.base + jpoolData.apy;
                            break;
                        }
                        default: {
                            elizaLogger.error(
                                `Unsupported protocol: ${pool.protocolName}`
                            );
                            break;
                        }
                    }
                    await sleep(1500); // Rate limiting between requests
                }

                elizaLogger.log(
                    `Fetched data for ${pool.protocolName}: APY: ${apy}, TVL: ${tvl}`
                );
                pools[key] = {
                    totalApy: apy,
                    tvl: tvl,
                    miningApy: 0,
                    airdropExpectation: "",
                    protocolName: pool.protocolName,
                };
            } catch (error) {
                elizaLogger.error(
                    `Error fetching data for ${pool.protocolName}:`,
                    error
                );
            }
        }

        const data: StakeProtocolData = {
            pools,
            timestamp: Date.now(),
        };

        this.cache.set(cacheKey, data);
        return data;
    }

    /**
     * Public method to retrieve stake pool information
     * @returns Promise<StakeProtocolData> with current pool data
     */
    async getStakePoolInfo(): Promise<StakeProtocolData> {
        return await this.fetchPoolData();
    }
}

/**
 * Provider implementation for stake protocol
 * Exports a singleton instance that can be used to fetch stake pool data
 */
const stakeProtocolProvider: Provider = {
    async get(): Promise<StakeProtocolData | string | null> {
        try {
            const connection = new Connection(
                "https://api.mainnet-beta.solana.com"
            );
            const provider = new StakeProtocolProvider(connection);
            return await provider.getStakePoolInfo();
        } catch (error) {
            elizaLogger.error("Error in stake protocol provider:", error);
            return "Sorry, I couldn't fetch the stake protocol data at the moment.";
        }
    },
};

export { stakeProtocolProvider };
