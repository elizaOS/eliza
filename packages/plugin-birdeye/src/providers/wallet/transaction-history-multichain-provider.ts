import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface Transaction {
    chain: Chain;
    hash: string;
    timestamp: number;
    type: string;
    status: "success" | "failed" | "pending";
    value: number;
    fee: number;
    from: string;
    to: string;
    tokenTransfers?: {
        token: string;
        amount: number;
        value: number;
    }[];
}

interface TransactionHistoryResponse {
    transactions: Transaction[];
}

// Constants
const MULTICHAIN_HISTORY_KEYWORDS = [
    "multichain transactions",
    "cross chain transactions",
    "all chain transactions",
    "transactions across chains",
    "transaction history all chains",
] as const;

// Helper functions
const containsMultichainHistoryKeyword = (text: string): boolean => {
    return MULTICHAIN_HISTORY_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const extractWalletAddress = (text: string): string | null => {
    // Look for wallet address patterns
    const addressMatch = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    return addressMatch ? addressMatch[0] : null;
};

const getTransactionHistory = async (
    apiKey: string,
    walletAddress: string
): Promise<TransactionHistoryResponse | null> => {
    try {
        const url = `${BASE_URL}/wallet/transaction_history_multichain`;

        elizaLogger.info("Fetching multichain transaction history from:", url);

        return await makeApiRequest<TransactionHistoryResponse>(url, {
            apiKey,
            chain: "solana",
            body: { wallet: walletAddress },
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching transaction history:",
                error.message
            );
        }
        return null;
    }
};

const formatTransactionStatus = (status: Transaction["status"]): string => {
    switch (status) {
        case "success":
            return "✅";
        case "failed":
            return "❌";
        case "pending":
            return "⏳";
        default:
            return "❓";
    }
};

const formatTransactionHistoryResponse = (
    data: TransactionHistoryResponse
): string => {
    let response = "📜 Multichain Transaction History\n\n";

    // Group transactions by chain
    const txsByChain = data.transactions.reduce(
        (acc, tx) => {
            if (!acc[tx.chain]) {
                acc[tx.chain] = [];
            }
            acc[tx.chain].push(tx);
            return acc;
        },
        {} as Record<Chain, Transaction[]>
    );

    // Format transactions by chain
    Object.entries(txsByChain).forEach(([chain, transactions]) => {
        response += `${chain.toUpperCase()} Transactions\n`;

        // Sort transactions by timestamp (newest first)
        transactions.sort((a, b) => b.timestamp - a.timestamp);

        transactions.forEach((tx) => {
            const date = new Date(tx.timestamp * 1000).toLocaleString();
            const statusEmoji = formatTransactionStatus(tx.status);

            response += `${statusEmoji} ${tx.type} - ${date}\n`;
            response += `• Hash: ${tx.hash}\n`;
            response += `• Value: $${tx.value.toLocaleString()}\n`;
            response += `• Fee: $${tx.fee.toFixed(6)}\n`;
            response += `• From: ${tx.from}\n`;
            response += `• To: ${tx.to}\n`;

            if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
                response += "• Token Transfers:\n";
                tx.tokenTransfers.forEach((transfer) => {
                    response += `  - ${transfer.token}: ${transfer.amount} ($${transfer.value.toLocaleString()})\n`;
                });
            }

            response += "\n";
        });
    });

    return response.trim();
};

export const transactionHistoryMultichainProvider: Provider = {
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

        if (!containsMultichainHistoryKeyword(messageText)) {
            return null;
        }

        const walletAddress = extractWalletAddress(messageText);
        if (!walletAddress) {
            return "Please provide a valid wallet address to check the transaction history.";
        }

        elizaLogger.info("TRANSACTION_HISTORY_MULTICHAIN provider activated");

        const historyData = await getTransactionHistory(apiKey, walletAddress);

        if (!historyData) {
            return null;
        }

        return formatTransactionHistoryResponse(historyData);
    },
};
