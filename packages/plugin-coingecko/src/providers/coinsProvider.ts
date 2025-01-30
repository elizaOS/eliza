import { type IAgentRuntime, type Memory, type Provider, type State, elizaLogger } from "@elizaos/core";
import axios from 'axios';
import { getApiConfig, validateCoingeckoConfig } from '../environment';

interface CoinItem {
    id: string;
    symbol: string;
    name: string;
}

const CACHE_KEY = 'coingecko:coins';
const CACHE_TTL = 5 * 60; // 5 minutes
const MAX_RETRIES = 3;

async function fetchCoins(runtime: IAgentRuntime, includePlatform = false): Promise<CoinItem[]> {
    const config = await validateCoingeckoConfig(runtime);
    const { baseUrl, apiKey, headerKey } = getApiConfig(config);

    const response = await axios.get<CoinItem[]>(
        `${baseUrl}/coins/list`,
        {
            params: {
                include_platform: includePlatform
            },
            headers: {
                'accept': 'application/json',
                [headerKey]: apiKey
            },
            timeout: 5000 // 5 second timeout
        }
    );

    if (!response.data?.length) {
        throw new Error("Invalid coins data received");
    }

    return response.data;
}

async function fetchWithRetry(runtime: IAgentRuntime, includePlatform = false): Promise<CoinItem[]> {
    let lastError: Error | null = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            return await fetchCoins(runtime, includePlatform);
        } catch (error) {
            lastError = error;
            elizaLogger.error(`Coins fetch attempt ${i + 1} failed:`, error);
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }

    throw lastError || new Error("Failed to fetch coins after multiple attempts");
}

async function getCoins(runtime: IAgentRuntime, includePlatform = false): Promise<CoinItem[]> {
    try {
        // Try to get from cache first
        const cached = await runtime.cacheManager.get<CoinItem[]>(CACHE_KEY);
        if (cached) {
            return cached;
        }

        // Fetch fresh data
        const coins = await fetchWithRetry(runtime, includePlatform);

        // Cache the result
        await runtime.cacheManager.set(CACHE_KEY, coins, { expires: CACHE_TTL });

        return coins;
    } catch (error) {
        elizaLogger.error("Error fetching coins:", error);
        throw error;
    }
}

function formatCoinsContext(coins: CoinItem[]): string {
    const popularCoins = [
        'bitcoin', 'ethereum', 'binancecoin', 'ripple',
        'cardano', 'solana', 'polkadot', 'dogecoin'
    ];

    const popular = coins
        .filter(c => popularCoins.includes(c.id))
        .map(c => `${c.name} (${c.symbol.toUpperCase()}) - ID: ${c.id}`);

    return `
Available cryptocurrencies:

Popular coins:
${popular.map(c => `- ${c}`).join('\n')}

Total available coins: ${coins.length}

You can use these coin IDs when querying specific cryptocurrency data.
`.trim();
}

export const coinsProvider: Provider = {
    // eslint-disable-next-line
    get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string> => {
        try {
            const coins = await getCoins(runtime);
            return formatCoinsContext(coins);
        } catch (error) {
            elizaLogger.error("Coins provider error:", error);
            return "Cryptocurrency list is temporarily unavailable. Please try again later.";
        }
    }
};

// Helper function for actions to get raw coins data
export async function getCoinsData(runtime: IAgentRuntime, includePlatform = false): Promise<CoinItem[]> {
    return getCoins(runtime, includePlatform);
}
