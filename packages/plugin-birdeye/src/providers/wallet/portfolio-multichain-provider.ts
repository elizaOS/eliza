import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface TokenHolding {
    chain: Chain;
    tokenAddress: string;
    symbol: string;
    name: string;
    balance: number;
    price: number;
    value: number;
    priceChange24h: number;
}

interface MultichainPortfolioResponse {
    holdings: TokenHolding[];
    totalValue: number;
    valueChange24h: number;
}

// Constants
const MULTICHAIN_PORTFOLIO_KEYWORDS = [
    "multichain portfolio",
    "cross chain portfolio",
    "all chain portfolio",
    "portfolio across chains",
    "portfolio on all chains",
] as const;

// Helper functions
const containsMultichainPortfolioKeyword = (text: string): boolean => {
    return MULTICHAIN_PORTFOLIO_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractWalletAddress = (text: string): string | null => {
    // Look for wallet address patterns
    const addressMatch = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    return addressMatch ? addressMatch[0] : null;
};

const getMultichainPortfolio = async (
    apiKey: string,
    walletAddress: string
): Promise<MultichainPortfolioResponse | null> => {
    try {
        const url = `${BASE_URL}/wallet/portfolio_multichain`;

        elizaLogger.info("Fetching multichain portfolio from:", url);

        return await makeApiRequest<MultichainPortfolioResponse>(url, {
            apiKey,
            chain: "solana",
            body: { wallet: walletAddress },
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching multichain portfolio:",
                error.message
            );
        }
        return null;
    }
};

const formatMultichainPortfolioResponse = (
    data: MultichainPortfolioResponse
): string => {
    let response = "🌐 Multichain Portfolio Overview\n\n";

    // Add total portfolio value and 24h change
    const valueChangePercent = (data.valueChange24h * 100).toFixed(2);
    const valueChangeEmoji = data.valueChange24h >= 0 ? "📈" : "📉";

    response += `Total Portfolio Value: $${data.totalValue.toLocaleString()}\n`;
    response += `24h Change: ${valueChangePercent}% ${valueChangeEmoji}\n\n`;

    // Group holdings by chain
    const holdingsByChain = data.holdings.reduce(
        (acc, holding) => {
            if (!acc[holding.chain]) {
                acc[holding.chain] = [];
            }
            acc[holding.chain].push(holding);
            return acc;
        },
        {} as Record<Chain, TokenHolding[]>
    );

    // Format holdings by chain
    Object.entries(holdingsByChain).forEach(([chain, holdings]) => {
        response += `${chain.toUpperCase()} Holdings\n`;

        // Sort holdings by value
        holdings.sort((a, b) => b.value - a.value);

        holdings.forEach((holding) => {
            const priceChangePercent = (holding.priceChange24h * 100).toFixed(
                2
            );
            const priceChangeEmoji = holding.priceChange24h >= 0 ? "📈" : "📉";

            response += `• ${holding.name} (${holding.symbol})\n`;
            response += `  - Balance: ${holding.balance.toLocaleString()}\n`;
            response += `  - Price: $${holding.price.toFixed(6)}\n`;
            response += `  - Value: $${holding.value.toLocaleString()}\n`;
            response += `  - 24h Change: ${priceChangePercent}% ${priceChangeEmoji}\n\n`;
        });
    });

    return response.trim();
};

export const portfolioMultichainProvider: Provider = {
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

        if (!containsMultichainPortfolioKeyword(messageText)) {
            return null;
        }

        const walletAddress = extractWalletAddress(messageText);
        if (!walletAddress) {
            return "Please provide a valid wallet address to check the multichain portfolio.";
        }

        elizaLogger.info("PORTFOLIO_MULTICHAIN provider activated");

        const portfolioData = await getMultichainPortfolio(
            apiKey,
            walletAddress
        );

        if (!portfolioData) {
            return null;
        }

        return formatMultichainPortfolioResponse(portfolioData);
    },
};
