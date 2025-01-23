import type { Plugin } from "@elizaos/core";
import { walletProvider, getClient } from "./provider";
import { getAgentKitActions } from "./actions";

// Initial banner
console.log("\n┌════════════════════════════════════════┐");
console.log("│          AGENTKIT PLUGIN               │");
console.log("├────────────────────────────────────────┤");
console.log("│  Initializing AgentKit Plugin...       │");
console.log("│  Version: 0.0.1                        │");
console.log("└════════════════════════════════════════┘");

const initializeActions = async () => {
    try {
        // Validate environment variables
        const apiKeyName = process.env.CDP_API_KEY_NAME;
        const apiKeyPrivateKey = process.env.CDP_API_KEY_PRIVATE_KEY;

        if (!apiKeyName || !apiKeyPrivateKey) {
            console.warn("⚠️ Missing CDP API credentials - AgentKit actions will not be available");
            return [];
        }

        const actions = await getAgentKitActions({
            getClient,
        });
        console.log("✔ AgentKit actions initialized successfully.");
        return actions;
    } catch (error) {
        console.error("❌ Failed to initialize AgentKit actions:", error);
        return []; // Return empty array instead of failing
    }
};

export const agentKitPlugin: Plugin = {
    name: "[AgentKit] Integration",
    description: "AgentKit integration plugin",
    providers: [walletProvider],
    evaluators: [],
    services: [],
    actions: await initializeActions(),
};

export default agentKitPlugin;
