import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import {
    BASE_URL,
    Chain,
    extractChain,
    extractContractAddresses,
    extractLimit,
    formatValue,
    makeApiRequest,
    shortenAddress,
} from "../utils";

// Types
interface HolderData {
    address: string;
    balance: number;
    balanceUSD: number;
    share: number;
    rank: number;
}

interface TokenHolderResponse {
    holders: HolderData[];
    totalCount: number;
    token: string;
}

// Constants
const HOLDER_KEYWORDS = [
    "holders",
    "holding",
    "token holders",
    "token holding",
    "who holds",
    "who owns",
    "ownership",
    "distribution",
    "token distribution",
    "token ownership",
    "top holders",
    "largest holders",
    "biggest holders",
    "whale holders",
    "whale watching",
] as const;

// Helper functions
const containsHolderKeyword = (text: string): boolean => {
    return HOLDER_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenHolders = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain,
    limit: number
): Promise<TokenHolderResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
            limit: limit.toString(),
        });
        const url = `${BASE_URL}/token/holder?${params.toString()}`;

        elizaLogger.info(
            `Fetching token holders for ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<TokenHolderResponse>(url, {
            apiKey,
            chain,
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching token holders:", error.message);
        }
        return null;
    }
};

const formatHolderData = (holder: HolderData): string => {
    let response = `${holder.rank}. ${shortenAddress(holder.address)}\n`;
    response += `   • Balance: ${holder.balance ? formatValue(holder.balance) : "N/A"}\n`;
    response += `   • Value: ${holder.balanceUSD ? formatValue(holder.balanceUSD) : "N/A"}\n`;
    response += `   • Share: ${holder.share ? holder.share.toFixed(2) : "0.00"}%`;
    return response;
};

const analyzeDistribution = (holders: HolderData[]): string => {
    // Calculate concentration metrics
    const top10Share = holders
        .slice(0, 10)
        .reduce((sum, h) => sum + h.share, 0);
    const top20Share = holders
        .slice(0, 20)
        .reduce((sum, h) => sum + h.share, 0);
    const top50Share = holders
        .slice(0, 50)
        .reduce((sum, h) => sum + h.share, 0);

    let analysis = "";

    // Analyze top holder concentration
    const topHolder = holders[0];
    if (topHolder.share > 50) {
        analysis +=
            "🚨 Extremely high concentration: Top holder owns majority of supply. ";
    } else if (topHolder.share > 20) {
        analysis +=
            "⚠️ High concentration: Top holder owns significant portion. ";
    } else if (topHolder.share > 10) {
        analysis +=
            "ℹ️ Moderate concentration: Top holder owns notable portion. ";
    } else {
        analysis +=
            "✅ Good distribution: No single holder owns dominant share. ";
    }

    // Analyze overall distribution
    if (top10Share > 80) {
        analysis +=
            "Top 10 holders control vast majority of supply, indicating high centralization. ";
    } else if (top10Share > 50) {
        analysis +=
            "Top 10 holders control majority of supply, showing moderate centralization. ";
    } else {
        analysis +=
            "Top 10 holders control less than half of supply, suggesting good distribution. ";
    }

    // Provide distribution metrics
    analysis += `\n\nDistribution Metrics:\n`;
    analysis += `• Top 10 Holders: ${top10Share.toFixed(2)}%\n`;
    analysis += `• Top 20 Holders: ${top20Share.toFixed(2)}%\n`;
    analysis += `• Top 50 Holders: ${top50Share.toFixed(2)}%`;

    return analysis;
};

const formatHolderResponse = (
    data: TokenHolderResponse,
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Token Holders for ${data.token} on ${chainName}\n\n`;

    if (data.holders.length === 0) {
        return response + "No holder data found.";
    }

    response += `📊 Distribution Analysis\n`;
    response += analyzeDistribution(data.holders);
    response += "\n\n";

    response += `👥 Top Holders\n`;
    data.holders.forEach((holder) => {
        response += formatHolderData(holder) + "\n\n";
    });

    if (data.totalCount > data.holders.length) {
        response += `Showing ${data.holders.length} of ${data.totalCount} total holders.`;
    }

    return response;
};

export const tokenHolderProvider: Provider = {
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

        if (!containsHolderKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);
        const limit = extractLimit(messageText);

        elizaLogger.info(
            `TOKEN HOLDER provider activated for ${addresses[0]} on ${chain}`
        );

        const holderData = await getTokenHolders(
            apiKey,
            addresses[0],
            chain,
            limit
        );

        if (!holderData) {
            return null;
        }

        return formatHolderResponse(holderData, chain);
    },
};
