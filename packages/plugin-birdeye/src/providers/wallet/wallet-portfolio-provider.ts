import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface TokenBalance {
    token: string;
    symbol: string;
    amount: number;
    price: number;
    value: number;
    decimals: number;
    logoURI?: string;
}

interface PortfolioData {
    totalValue: number;
    tokens: TokenBalance[];
    lastUpdated: number;
}

interface MultichainPortfolioData {
    chains: Record<string, PortfolioData>;
    totalValue: number;
}

// Constants
const PORTFOLIO_KEYWORDS = [
    "portfolio",
    "holdings",
    "balance",
    "assets",
    "tokens",
    "wallet",
    "what do i own",
    "what do i have",
] as const;

const MULTICHAIN_KEYWORDS = [
    "all chains",
    "multichain",
    "multi-chain",
    "cross chain",
    "cross-chain",
    "every chain",
    "all networks",
] as const;

const CHAIN_KEYWORDS = [
    "solana",
    "ethereum",
    "arbitrum",
    "avalanche",
    "bsc",
    "optimism",
    "polygon",
    "base",
    "zksync",
    "sui",
] as const;

const BASE_URL = "https://public-api.birdeye.so";

// Helper functions
const containsPortfolioKeyword = (text: string): boolean => {
    return PORTFOLIO_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const isMultichainRequest = (text: string): boolean => {
    return MULTICHAIN_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractChain = (text: string): string => {
    const chain = CHAIN_KEYWORDS.find((chain) =>
        text.toLowerCase().includes(chain.toLowerCase())
    );
    return chain || "solana";
};

const extractWalletAddress = (text: string): string | null => {
    const words = text.split(/\s+/);

    for (const word of words) {
        // Ethereum-like addresses (0x...)
        if (/^0x[a-fA-F0-9]{40}$/i.test(word)) {
            return word;
        }
        // Solana addresses (base58, typically 32-44 chars)
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(word)) {
            return word;
        }
    }
    return null;
};

const getWalletPortfolio = async (
    apiKey: string,
    walletAddress: string,
    chain: string = "solana"
): Promise<PortfolioData | null> => {
    try {
        const params = new URLSearchParams({
            wallet: walletAddress,
        });
        const url = `${BASE_URL}/wallet/portfolio?${params.toString()}`;

        elizaLogger.info(
            `Fetching portfolio for wallet ${walletAddress} on ${chain} from:`,
            url
        );

        const response = await fetch(url, {
            headers: {
                "X-API-KEY": apiKey,
                "x-chain": chain,
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                elizaLogger.warn(
                    `Wallet not found: ${walletAddress} on ${chain}`
                );
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.data;
    } catch (error) {
        elizaLogger.error("Error fetching wallet portfolio:", error);
        return null;
    }
};

const getMultichainPortfolio = async (
    apiKey: string,
    walletAddress: string
): Promise<MultichainPortfolioData | null> => {
    try {
        const params = new URLSearchParams({
            wallet: walletAddress,
        });
        const url = `${BASE_URL}/wallet/portfolio_multichain?${params.toString()}`;

        elizaLogger.info(
            `Fetching multichain portfolio for wallet ${walletAddress} from:`,
            url
        );

        const response = await fetch(url, {
            headers: {
                "X-API-KEY": apiKey,
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                elizaLogger.warn(`Wallet not found: ${walletAddress}`);
                return null;
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        // Transform the response to match our interface
        const { totalValue, ...chains } = data.data;
        return {
            chains,
            totalValue,
        };
    } catch (error) {
        elizaLogger.error("Error fetching multichain portfolio:", error);
        return null;
    }
};

const formatValue = (value: number): string => {
    if (value >= 1_000_000_000) {
        return `$${(value / 1_000_000_000).toFixed(2)}B`;
    }
    if (value >= 1_000_000) {
        return `$${(value / 1_000_000).toFixed(2)}M`;
    }
    if (value >= 1_000) {
        return `$${(value / 1_000).toFixed(2)}K`;
    }
    return `$${value.toFixed(2)}`;
};

const formatTokenAmount = (amount: number, decimals: number): string => {
    const formattedAmount = amount / Math.pow(10, decimals);
    if (formattedAmount >= 1_000_000) {
        return `${(formattedAmount / 1_000_000).toFixed(2)}M`;
    }
    if (formattedAmount >= 1_000) {
        return `${(formattedAmount / 1_000).toFixed(2)}K`;
    }
    return formattedAmount.toFixed(decimals > 6 ? 4 : 2);
};

const formatSingleChainPortfolio = (
    data: PortfolioData,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Portfolio on ${chainName}:\n\n`;

    response += `💰 Total Value: ${formatValue(data.totalValue)}\n\n`;

    if (data.tokens.length === 0) {
        response += "No tokens found in this wallet.";
        return response;
    }

    response += `Token Holdings:\n`;
    data.tokens
        .sort((a, b) => b.value - a.value)
        .forEach((token) => {
            const amount = formatTokenAmount(token.amount, token.decimals);
            response += `• ${token.symbol}: ${amount} (${formatValue(token.value)})\n`;
        });

    response += `\nLast Updated: ${new Date(data.lastUpdated * 1000).toLocaleString()}`;
    return response;
};

const formatMultichainPortfolio = (data: MultichainPortfolioData): string => {
    let response = `Multichain Portfolio Overview:\n\n`;
    response += `💰 Total Portfolio Value: ${formatValue(data.totalValue)}\n\n`;

    const chains = Object.keys(data.chains);
    if (chains.length === 0) {
        response += "No assets found across any chains.";
        return response;
    }

    chains
        .sort((a, b) => data.chains[b].totalValue - data.chains[a].totalValue)
        .forEach((chain) => {
            const chainData = data.chains[chain];
            if (chainData.totalValue > 0) {
                const chainName =
                    chain.charAt(0).toUpperCase() + chain.slice(1);
                response += `${chainName} (${formatValue(chainData.totalValue)}):\n`;
                chainData.tokens
                    .sort((a, b) => b.value - a.value)
                    .slice(0, 5) // Show top 5 tokens per chain
                    .forEach((token) => {
                        const amount = formatTokenAmount(
                            token.amount,
                            token.decimals
                        );
                        response += `• ${token.symbol}: ${amount} (${formatValue(token.value)})\n`;
                    });
                if (chainData.tokens.length > 5) {
                    response += `  ... and ${chainData.tokens.length - 5} more tokens\n`;
                }
                response += "\n";
            }
        });

    return response;
};

export const walletPortfolioProvider: Provider = {
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

        if (!containsPortfolioKeyword(messageText)) {
            return null;
        }

        const walletAddress = extractWalletAddress(messageText);
        if (!walletAddress) {
            return null;
        }

        const isMultichain = isMultichainRequest(messageText);

        if (isMultichain) {
            elizaLogger.info(
                `MULTICHAIN PORTFOLIO provider activated for wallet ${walletAddress}`
            );

            const portfolioData = await getMultichainPortfolio(
                apiKey,
                walletAddress
            );

            if (!portfolioData) {
                return null;
            }

            return formatMultichainPortfolio(portfolioData);
        } else {
            const chain = extractChain(messageText);

            elizaLogger.info(
                `PORTFOLIO provider activated for wallet ${walletAddress} on ${chain}`
            );

            const portfolioData = await getWalletPortfolio(
                apiKey,
                walletAddress,
                chain
            );

            if (!portfolioData) {
                return null;
            }

            return formatSingleChainPortfolio(portfolioData, chain);
        }
    },
};
