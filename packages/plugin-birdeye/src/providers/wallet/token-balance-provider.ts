import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface TokenBalance {
    tokenAddress: string;
    symbol: string;
    name: string;
    balance: number;
    decimals: number;
    price: number;
    value: number;
    priceChange24h: number;
}

interface TokenBalanceResponse {
    balances: TokenBalance[];
    totalValue: number;
    valueChange24h: number;
}

// Constants
const TOKEN_BALANCE_KEYWORDS = [
    "token balance",
    "token holdings",
    "wallet balance",
    "wallet holdings",
    "check balance",
    "check holdings",
] as const;

// Helper functions
const containsTokenBalanceKeyword = (text: string): boolean => {
    return TOKEN_BALANCE_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractWalletAddress = (text: string): string | null => {
    // Look for wallet address patterns
    const addressMatch = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    return addressMatch ? addressMatch[0] : null;
};

const getTokenBalance = async (
    apiKey: string,
    walletAddress: string,
    chain: Chain = "solana"
): Promise<TokenBalanceResponse | null> => {
    try {
        const url = `${BASE_URL}/wallet/token_balance`;

        elizaLogger.info("Fetching token balance from:", url);

        return await makeApiRequest<TokenBalanceResponse>(url, {
            apiKey,
            chain,
            body: { wallet: walletAddress },
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching token balance:", error.message);
        }
        return null;
    }
};

const formatTokenBalanceResponse = (data: TokenBalanceResponse): string => {
    let response = "💰 Token Balance Overview\n\n";

    // Add total value and 24h change
    const valueChangePercent = (data.valueChange24h * 100).toFixed(2);
    const valueChangeEmoji = data.valueChange24h >= 0 ? "📈" : "📉";

    response += `Total Value: $${data.totalValue.toLocaleString()}\n`;
    response += `24h Change: ${valueChangePercent}% ${valueChangeEmoji}\n\n`;

    // Sort balances by value
    const sortedBalances = [...data.balances].sort((a, b) => b.value - a.value);

    // Format individual token balances
    sortedBalances.forEach((balance) => {
        const priceChangePercent = (balance.priceChange24h * 100).toFixed(2);
        const priceChangeEmoji = balance.priceChange24h >= 0 ? "📈" : "📉";

        response += `${balance.name} (${balance.symbol})\n`;
        response += `• Balance: ${balance.balance.toLocaleString()}\n`;
        response += `• Price: $${balance.price.toFixed(6)}\n`;
        response += `• Value: $${balance.value.toLocaleString()}\n`;
        response += `• 24h Change: ${priceChangePercent}% ${priceChangeEmoji}\n\n`;
    });

    return response.trim();
};

export const tokenBalanceProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string | null> => {
        const apiKey = runtime.getSetting("BIRDEYE_API_KEY");
        if (!apiKey) {
            elizaLogger.error("BIRDEYE_API_KEY not found in runtime settings");
            return null;
        }

        const messageText = message.content.text;

        if (!containsTokenBalanceKeyword(messageText)) {
            return null;
        }

        const walletAddress = extractWalletAddress(messageText);
        if (!walletAddress) {
            return "Please provide a valid wallet address to check the token balance.";
        }

        elizaLogger.info("TOKEN_BALANCE provider activated");

        const balanceData = await getTokenBalance(apiKey, walletAddress);

        if (!balanceData) {
            return null;
        }

        return formatTokenBalanceResponse(balanceData);
    },
};
