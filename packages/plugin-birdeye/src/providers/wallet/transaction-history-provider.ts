import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";

// Types
interface TokenTransfer {
    token: string;
    symbol: string;
    amount: number;
    value: number;
    decimals: number;
}

interface Transaction {
    hash: string;
    timestamp: number;
    type: "send" | "receive" | "swap" | "mint" | "burn" | "other";
    from: string;
    to: string;
    value: number;
    fee: number;
    success: boolean;
    transfers: TokenTransfer[];
}

interface TransactionHistory {
    transactions: Transaction[];
    totalCount: number;
}

interface MultichainTransactionHistory {
    [chain: string]: TransactionHistory;
}

// Constants
const TRANSACTION_KEYWORDS = [
    "transaction",
    "transactions",
    "history",
    "transfers",
    "activity",
    "trades",
    "swaps",
    "sent",
    "received",
    "tx",
    "txs",
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
const containsTransactionKeyword = (text: string): boolean => {
    return TRANSACTION_KEYWORDS.some((keyword) =>
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

const getTransactionHistory = async (
    apiKey: string,
    walletAddress: string,
    chain: string = "solana",
    limit: number = 10
): Promise<TransactionHistory | null> => {
    try {
        const params = new URLSearchParams({
            wallet: walletAddress,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/wallet/transaction_history?${params.toString()}`;

        elizaLogger.info(
            `Fetching transaction history for wallet ${walletAddress} on ${chain} from:`,
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
        elizaLogger.error("Error fetching transaction history:", error);
        return null;
    }
};

const getMultichainTransactionHistory = async (
    apiKey: string,
    walletAddress: string,
    limit: number = 10
): Promise<MultichainTransactionHistory | null> => {
    try {
        const params = new URLSearchParams({
            wallet: walletAddress,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/wallet/transaction_history_multichain?${params.toString()}`;

        elizaLogger.info(
            `Fetching multichain transaction history for wallet ${walletAddress} from:`,
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
        return data.data;
    } catch (error) {
        elizaLogger.error(
            "Error fetching multichain transaction history:",
            error
        );
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

const shortenAddress = (address: string): string => {
    if (address.length <= 12) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const formatTransactionType = (type: string): string => {
    switch (type.toLowerCase()) {
        case "send":
            return "📤 Sent";
        case "receive":
            return "📥 Received";
        case "swap":
            return "🔄 Swapped";
        case "mint":
            return "🌟 Minted";
        case "burn":
            return "🔥 Burned";
        default:
            return "📝 Other";
    }
};

const formatSingleChainHistory = (
    history: TransactionHistory,
    chain: string
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
    let response = `Transaction History on ${chainName}:\n\n`;

    if (history.transactions.length === 0) {
        return response + "No transactions found.";
    }

    history.transactions.forEach((tx, index) => {
        const date = new Date(tx.timestamp * 1000).toLocaleString();
        response += `${index + 1}. ${formatTransactionType(tx.type)} - ${date}\n`;
        response += `• Hash: ${shortenAddress(tx.hash)}\n`;
        response += `• From: ${shortenAddress(tx.from)}\n`;
        response += `• To: ${shortenAddress(tx.to)}\n`;
        response += `• Value: ${formatValue(tx.value)}\n`;
        response += `• Fee: ${formatValue(tx.fee)}\n`;
        response += `• Status: ${tx.success ? "✅ Success" : "❌ Failed"}\n`;

        if (tx.transfers.length > 0) {
            response += "• Tokens:\n";
            tx.transfers.forEach((transfer) => {
                const amount = formatTokenAmount(
                    transfer.amount,
                    transfer.decimals
                );
                response += `  - ${amount} ${transfer.symbol} (${formatValue(transfer.value)})\n`;
            });
        }
        response += "\n";
    });

    if (history.totalCount > history.transactions.length) {
        response += `\nShowing ${history.transactions.length} of ${history.totalCount} total transactions.`;
    }

    return response;
};

const formatMultichainHistory = (
    history: MultichainTransactionHistory
): string => {
    let response = `Multichain Transaction History:\n\n`;

    const chains = Object.keys(history);
    if (chains.length === 0) {
        return response + "No transactions found on any chain.";
    }

    chains.forEach((chain) => {
        const chainData = history[chain];
        if (chainData.transactions.length > 0) {
            const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);
            response += `${chainName} (${chainData.totalCount} total transactions):\n`;

            chainData.transactions
                .slice(0, 5) // Show only the 5 most recent transactions per chain
                .forEach((tx, index) => {
                    const date = new Date(tx.timestamp * 1000).toLocaleString();
                    response += `${index + 1}. ${formatTransactionType(tx.type)} - ${date}\n`;
                    response += `   Value: ${formatValue(tx.value)} | Status: ${tx.success ? "✅" : "❌"}\n`;
                });

            if (chainData.transactions.length > 5) {
                response += `   ... and ${chainData.totalCount - 5} more transactions\n`;
            }
            response += "\n";
        }
    });

    return response;
};

export const transactionHistoryProvider: Provider = {
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

        if (!containsTransactionKeyword(messageText)) {
            return null;
        }

        const walletAddress = extractWalletAddress(messageText);
        if (!walletAddress) {
            return null;
        }

        const isMultichain = isMultichainRequest(messageText);

        if (isMultichain) {
            elizaLogger.info(
                `MULTICHAIN TRANSACTION HISTORY provider activated for wallet ${walletAddress}`
            );

            const historyData = await getMultichainTransactionHistory(
                apiKey,
                walletAddress
            );

            if (!historyData) {
                return null;
            }

            return formatMultichainHistory(historyData);
        } else {
            const chain = extractChain(messageText);

            elizaLogger.info(
                `TRANSACTION HISTORY provider activated for wallet ${walletAddress} on ${chain}`
            );

            const historyData = await getTransactionHistory(
                apiKey,
                walletAddress,
                chain
            );

            if (!historyData) {
                return null;
            }

            return formatSingleChainHistory(historyData, chain);
        }
    },
};
