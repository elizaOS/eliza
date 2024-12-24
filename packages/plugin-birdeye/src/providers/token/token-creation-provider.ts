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
    formatTimestamp,
    formatValue,
    makeApiRequest,
    shortenAddress,
} from "../utils";

// Types
interface CreationData {
    creator: string;
    creatorBalance: number;
    creatorBalanceUSD: number;
    creatorShare: number;
    creationTime: number;
    initialSupply: number;
    initialSupplyUSD: number;
    creationTx: string;
}

interface CreationResponse {
    data: CreationData;
    token: string;
}

// Constants
const CREATION_KEYWORDS = [
    "creation",
    "creator",
    "created",
    "launch",
    "launched",
    "deployment",
    "deployed",
    "initial supply",
    "token creation",
    "token launch",
    "token deployment",
    "token origin",
    "token history",
    "token birth",
    "genesis",
] as const;

// Helper functions
const containsCreationKeyword = (text: string): boolean => {
    return CREATION_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenCreation = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain
): Promise<CreationResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/token/creation?${params.toString()}`;

        elizaLogger.info(
            `Fetching creation data for ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<CreationResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching creation data:", error.message);
        }
        return null;
    }
};

const analyzeCreationMetrics = (data: CreationData): string => {
    let analysis = "";

    // Analyze creator's share
    if (data.creatorShare > 50) {
        analysis +=
            "⚠️ Creator holds majority of supply, high concentration risk. ";
    } else if (data.creatorShare > 20) {
        analysis += "⚡ Creator maintains significant holdings. ";
    } else if (data.creatorShare > 5) {
        analysis += "✅ Creator retains moderate holdings. ";
    } else {
        analysis += "🔄 Creator holds minimal share of supply. ";
    }

    // Analyze initial supply value
    if (data.initialSupplyUSD > 1000000) {
        analysis +=
            "💰 Large initial supply value indicates significant launch. ";
    } else if (data.initialSupplyUSD > 100000) {
        analysis +=
            "💫 Moderate initial supply value suggests standard launch. ";
    } else {
        analysis +=
            "🌱 Small initial supply value indicates grassroots launch. ";
    }

    // Analyze creator's current position
    const valueChange = data.creatorBalanceUSD / data.initialSupplyUSD;
    if (valueChange > 1.5) {
        analysis += "📈 Creator's position has significantly appreciated. ";
    } else if (valueChange < 0.5) {
        analysis += "📉 Creator's position has notably decreased. ";
    }

    return analysis;
};

const formatCreationResponse = (
    data: CreationResponse,
    chain: Chain
): string => {
    const { data: creationData } = data;
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Token Creation Data for ${data.token} on ${chainName}\n\n`;

    // Creation Analysis
    response += "📊 Creation Analysis\n";
    response += analyzeCreationMetrics(creationData) + "\n\n";

    // Creation Details
    response += "🎂 Creation Details\n";
    response += `Creation Time: ${formatTimestamp(creationData.creationTime)}\n`;
    response += `Creator: ${shortenAddress(creationData.creator)}\n`;
    response += `Creation Tx: ${shortenAddress(creationData.creationTx)}\n\n`;

    // Supply Information
    response += "💰 Supply Information\n";
    response += `Initial Supply: ${formatValue(creationData.initialSupply)}\n`;
    response += `Initial Value: ${formatValue(creationData.initialSupplyUSD)}\n\n`;

    // Creator Holdings
    response += "👤 Creator Holdings\n";
    response += `Current Balance: ${formatValue(creationData.creatorBalance)}\n`;
    response += `Current Value: ${formatValue(creationData.creatorBalanceUSD)}\n`;
    response += `Share of Supply: ${creationData.creatorShare.toFixed(2)}%`;

    return response;
};

export const tokenCreationProvider: Provider = {
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

        if (!containsCreationKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `TOKEN CREATION provider activated for ${addresses[0]} on ${chain}`
        );

        const creationData = await getTokenCreation(
            apiKey,
            addresses[0],
            chain
        );

        if (!creationData) {
            return null;
        }

        return formatCreationResponse(creationData, chain);
    },
};
