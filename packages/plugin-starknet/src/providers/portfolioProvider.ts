import {
    elizaLogger,
    type IAgentRuntime,
    type Memory,
    type Provider,
    type State,
} from "@elizaos/core";

import { fetchWithRetry, getStarknetAccount } from "../utils";
import { ERC20Token } from "../utils/ERC20Token";
import { PORTFOLIO_TOKENS } from "./token.ts";

type CoingeckoPrices = {
    [cryptoName: string]: { usd: number };
};

type TokenBalances = {
    [tokenAddress: string]: bigint;
};

export class WalletProvider {
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    async getWalletPortfolio(): Promise<TokenBalances> {
        const cacheKey = `walletPortfolio-${this.runtime.agentId}`;
        const cachedValues =
            await this.runtime.cacheManager.get<TokenBalances>(cacheKey);
        if (cachedValues) {
            elizaLogger.debug("Using cached data for getWalletPortfolio()");
            return cachedValues;
        }

        const starknetAccount = getStarknetAccount(this.runtime);
        const balances: TokenBalances = {};

        // reading balances sequentially to prevent API issues
        for (const token of Object.values(PORTFOLIO_TOKENS)) {
            const erc20 = new ERC20Token(token.address, starknetAccount);
            const balance = await erc20.balanceOf(starknetAccount.address);
            balances[token.address] = balance;
        }

        await this.runtime.cacheManager.set(cacheKey, balances, {
            expires: Date.now() + 180 * 60 * 1000, // 3 hours cache
        });

        return balances;
    }

    async getTokenUsdValues(): Promise<CoingeckoPrices> {
        const cacheKey = "tokenUsdValues";
        const cachedValues =
            await this.runtime.cacheManager.get<CoingeckoPrices>(cacheKey);
        if (cachedValues) {
            elizaLogger.debug("Using cached data for getTokenUsdValues()");
            return cachedValues;
        }

        const coingeckoIds = Object.values(PORTFOLIO_TOKENS)
            .map((token) => token.coingeckoId)
            .join(",");

        const coingeckoPrices = await fetchWithRetry<CoingeckoPrices>(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoIds}&vs_currencies=usd`
        );

        await this.runtime.cacheManager.set(cacheKey, coingeckoPrices, {
            expires: Date.now() + 30 * 60 * 1000, // 30 minutes cache
        });

        return coingeckoPrices;
    }
}

const walletProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<string> => {
        const provider = new WalletProvider(runtime);
        let walletPortfolio: TokenBalances | null = null;
        let tokenUsdValues: CoingeckoPrices | null = null;

        try {
            walletPortfolio = await provider.getWalletPortfolio();
            tokenUsdValues = await provider.getTokenUsdValues();
        } catch (error) {
            elizaLogger.error("Error in walletProvider.get():", error);
            return "Unable to fetch wallet portfolio. Please try again later.";
        }

        const rows = Object.entries(PORTFOLIO_TOKENS)
            .map(([symbol, token]) => {
                const rawBalance = walletPortfolio[token.address];
                if (rawBalance === undefined) return null;

                const decimalBalance =
                    Number(rawBalance) / (10 ** token.decimals);  // Fix: Use exponentiation operator instead of Math.pow
                const price = tokenUsdValues[token.coingeckoId]?.usd ?? 0;
                const usdValue = decimalBalance * price;


                if (decimalBalance === 0 && usdValue === 0) return null;

                return `${symbol.padEnd(9)}| ${decimalBalance
                    .toFixed(18)
                    .replace(/\.?0+$/, "")
                    .padEnd(20)}| ${usdValue.toFixed(2)}`;
            })
            .filter((row): row is string => row !== null);

        const header = "symbol   | balance             | USD value";
        const separator = "==================================================";
        return [header, separator, ...rows].join("\n");
    },
};

export { walletProvider, type TokenBalances };
