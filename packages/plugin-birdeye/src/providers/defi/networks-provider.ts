import {
    IAgentRuntime,
    Memory,
    Provider,
    State,
    elizaLogger,
} from "@elizaos/core";
import { BASE_URL, makeApiRequest } from "../utils";

// Types
interface NetworkInfo {
    name: string;
    chainId: string;
    rpcUrl: string;
    explorerUrl: string;
    status: "active" | "maintenance" | "deprecated";
    features: string[];
}

interface NetworksResponse {
    networks: NetworkInfo[];
}

// Constants
const NETWORK_KEYWORDS = [
    "supported networks",
    "available networks",
    "supported chains",
    "available chains",
    "which networks",
    "which chains",
    "list networks",
    "list chains",
    "show networks",
    "show chains",
    "network support",
    "chain support",
] as const;

// Helper functions
const containsNetworkKeyword = (text: string): boolean => {
    return NETWORK_KEYWORDS.some((keyword) =>
        text.toLowerCase().includes(keyword.toLowerCase())
    );
};

const getNetworks = async (
    apiKey: string
): Promise<NetworksResponse | null> => {
    try {
        const url = `${BASE_URL}/defi/networks`;

        elizaLogger.info("Fetching supported networks from:", url);

        return await makeApiRequest<NetworksResponse>(url, {
            apiKey,
            chain: "solana",
        });
    } catch (error) {
        if (error instanceof Error) {
            elizaLogger.error("Error fetching networks:", error.message);
        }
        return null;
    }
};

const formatNetworkResponse = (data: NetworksResponse): string => {
    let response = "Supported Networks on Birdeye\n\n";

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
            response += `• ${network.name}\n`;
            response += `  - Chain ID: ${network.chainId}\n`;
            response += `  - Features: ${network.features.join(", ")}\n`;
            response += `  - Explorer: ${network.explorerUrl}\n\n`;
        });
    }

    // Format maintenance networks
    if (maintenanceNetworks.length > 0) {
        response += "🟡 Networks Under Maintenance\n";
        maintenanceNetworks.forEach((network) => {
            response += `• ${network.name}\n`;
            response += `  - Chain ID: ${network.chainId}\n`;
            response += `  - Features: ${network.features.join(", ")}\n\n`;
        });
    }

    // Format deprecated networks
    if (deprecatedNetworks.length > 0) {
        response += "🔴 Deprecated Networks\n";
        deprecatedNetworks.forEach((network) => {
            response += `• ${network.name}\n`;
            response += `  - Chain ID: ${network.chainId}\n\n`;
        });
    }

    return response.trim();
};

export const networksProvider: Provider = {
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

        if (!containsNetworkKeyword(messageText)) {
            return null;
        }

        elizaLogger.info("NETWORKS provider activated");

        const networksData = await getNetworks(apiKey);

        if (!networksData) {
            return null;
        }

        return formatNetworkResponse(networksData);
    },
};
