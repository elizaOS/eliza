import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, Chain, makeApiRequest } from "../utils";

// Types
interface NetworkSupport {
    chain: Chain;
    status: "active" | "maintenance" | "deprecated";
    features: string[];
}

interface SupportedNetworksResponse {
    networks: NetworkSupport[];
}

// Constants
const SUPPORTED_NETWORKS_KEYWORDS = [
    "supported wallet networks",
    "wallet networks",
    "wallet chains",
    "supported wallet chains",
    "wallet network support",
] as const;

// Helper functions
const containsSupportedNetworksKeyword = (text: string): boolean => {
    return SUPPORTED_NETWORKS_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getSupportedNetworks = async (
    apiKey: string
): Promise<SupportedNetworksResponse | null> => {
    try {
        const url = `${BASE_URL}/wallet/supported_networks`;

        elizaLogger.info("Fetching supported wallet networks from:", url);

        return await makeApiRequest<SupportedNetworksResponse>(url, {
            apiKey,
            chain: "solana",
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error(
                "Error fetching supported networks:",
                error.message
            );
        }
        return null;
    }
};

const formatSupportedNetworksResponse = (
    data: SupportedNetworksResponse
): string => {
    let response = "🌐 Supported Wallet Networks\n\n";

    // Group networks by status
    const activeNetworks = data.networks.filter((n) => n.status === "active");
    const maintenanceNetworks = data.networks.filter(
        (n) => n.status === "maintenance"
    );
    const deprecatedNetworks = data.networks.filter(
        (n) => n.status === "deprecated"
    );

    // Format active networks
    if (activeNetworks.length > 0) {
        response += "🟢 Active Networks\n";
        activeNetworks.forEach((network) => {
            response += `• ${network.chain}\n`;
            response += `  - Features: ${network.features.join(", ")}\n\n`;
        });
    }

    // Format maintenance networks
    if (maintenanceNetworks.length > 0) {
        response += "🟡 Networks Under Maintenance\n";
        maintenanceNetworks.forEach((network) => {
            response += `• ${network.chain}\n`;
            response += `  - Features: ${network.features.join(", ")}\n\n`;
        });
    }

    // Format deprecated networks
    if (deprecatedNetworks.length > 0) {
        response += "🔴 Deprecated Networks\n";
        deprecatedNetworks.forEach((network) => {
            response += `• ${network.chain}\n\n`;
        });
    }

    return response.trim();
};

export const supportedNetworksProvider: Provider = {
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

        if (!containsSupportedNetworksKeyword(messageText)) {
            return null;
        }

        elizaLogger.info("SUPPORTED_NETWORKS provider activated");

        const networksData = await getSupportedNetworks(apiKey);

        if (!networksData) {
            return null;
        }

        return formatSupportedNetworksResponse(networksData);
    },
};
