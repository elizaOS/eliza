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
    formatValue,
    makeApiRequest,
    shortenAddress,
} from "../utils";

// Types
interface MintBurnEvent {
    type: "mint" | "burn";
    amount: number;
    amountUSD: number;
    timestamp: number;
    txHash: string;
    address: string;
}

interface MintBurnResponse {
    events: MintBurnEvent[];
    token: string;
}

// Constants
const MINT_BURN_KEYWORDS = [
    "mint",
    "burn",
    "minting",
    "burning",
    "token supply",
    "supply changes",
    "token burns",
    "token mints",
    "supply history",
    "mint history",
    "burn history",
    "supply events",
] as const;

// Helper functions
const containsMintBurnKeyword = (text: string): boolean => {
    return MINT_BURN_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getTokenMintBurnHistory = async (
    apiKey: string,
    contractAddress: string,
    chain: Chain
): Promise<MintBurnResponse | null> => {
    try {
        const params = new URLSearchParams({
            address: contractAddress,
        });
        const url = `${BASE_URL}/token/mint_burn?${params.toString()}`;

        elizaLogger.info(
            `Fetching mint/burn history for ${contractAddress} on ${chain} from:`,
            url
        );

        return await makeApiRequest<MintBurnResponse>(url, { apiKey, chain });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching mint/burn history:",
                error.message
            );
        }
        return null;
    }
};

const formatEventData = (event: MintBurnEvent): string => {
    const date = new Date(event.timestamp * 1000).toLocaleString();
    const eventType = event.type === "mint" ? "🟢 Mint" : "🔴 Burn";

    let response = `${eventType} Event - ${date}\n`;
    response += `   • Amount: ${formatValue(event.amount)}\n`;
    response += `   • Value: ${formatValue(event.amountUSD)}\n`;
    response += `   • By: ${shortenAddress(event.address)}\n`;
    response += `   • Tx: ${shortenAddress(event.txHash)}`;
    return response;
};

const analyzeMintBurnTrends = (events: MintBurnEvent[]): string => {
    const mints = events.filter((e) => e.type === "mint");
    const burns = events.filter((e) => e.type === "burn");

    const totalMinted = mints.reduce((sum, e) => sum + e.amount, 0);
    const totalBurned = burns.reduce((sum, e) => sum + e.amount, 0);
    const netChange = totalMinted - totalBurned;

    let analysis = "📊 Supply Change Analysis\n\n";

    // Supply change metrics
    analysis += `Total Minted: ${formatValue(totalMinted)}\n`;
    analysis += `Total Burned: ${formatValue(totalBurned)}\n`;
    analysis += `Net Change: ${formatValue(Math.abs(netChange))} ${netChange >= 0 ? "increase" : "decrease"}\n\n`;

    // Activity analysis
    analysis += "Recent Activity:\n";
    if (mints.length === 0 && burns.length === 0) {
        analysis += "• No mint/burn activity in the period\n";
    } else {
        if (mints.length > 0) {
            analysis += `• ${mints.length} mint events\n`;
        }
        if (burns.length > 0) {
            analysis += `• ${burns.length} burn events\n`;
        }
    }

    // Supply trend
    if (netChange > 0) {
        analysis += "\n📈 Supply is expanding";
    } else if (netChange < 0) {
        analysis += "\n📉 Supply is contracting";
    } else {
        analysis += "\n➡️ Supply is stable";
    }

    return analysis;
};

const formatMintBurnResponse = (
    data: MintBurnResponse,
    chain: Chain
): string => {
    const chainName = chain.charAt(0).toUpperCase() + chain.slice(1);

    let response = `Mint/Burn History for ${data.token} on ${chainName}\n\n`;

    if (data.events.length === 0) {
        return response + "No mint/burn events found.";
    }

    response += analyzeMintBurnTrends(data.events);
    response += "\n\n📜 Recent Events\n";

    // Sort events by timestamp in descending order
    const sortedEvents = [...data.events].sort(
        (a, b) => b.timestamp - a.timestamp
    );
    sortedEvents.forEach((event) => {
        response += "\n" + formatEventData(event) + "\n";
    });

    return response;
};

export const tokenMintBurnProvider: Provider = {
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

        if (!containsMintBurnKeyword(messageText)) {
            return null;
        }

        const addresses = extractContractAddresses(messageText);
        if (addresses.length === 0) {
            return null;
        }

        const chain = extractChain(messageText);

        elizaLogger.info(
            `TOKEN MINT/BURN provider activated for ${addresses[0]} on ${chain}`
        );

        const mintBurnData = await getTokenMintBurnHistory(
            apiKey,
            addresses[0],
            chain
        );

        if (!mintBurnData) {
            return null;
        }

        return formatMintBurnResponse(mintBurnData, chain);
    },
};
