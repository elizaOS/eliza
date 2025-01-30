import { type IAgentRuntime, elizaLogger } from "@elizaos/core";

export async function validateEchoChamberConfig(
    runtime: IAgentRuntime
): Promise<void> {
    const apiUrl = runtime.getSetting("ECHOCHAMBERS_API_URL");
    const apiKey = runtime.getSetting("ECHOCHAMBERS_API_KEY");

    if (!apiUrl) {
        elizaLogger.error(
            "ECHOCHAMBERS_API_URL is required. Please set it in your environment variables."
        );
        throw new Error("ECHOCHAMBERS_API_URL is required");
    }

    if (!apiKey) {
        elizaLogger.error(
            "ECHOCHAMBERS_API_KEY is required. Please set it in your environment variables."
        );
        throw new Error("ECHOCHAMBERS_API_KEY is required");
    }

    // Validate API URL format
    try {
        new URL(apiUrl);
    } catch {
        elizaLogger.error(
            `Invalid ECHOCHAMBERS_API_URL format: ${apiUrl}. Please provide a valid URL.`
        );
        throw new Error("Invalid ECHOCHAMBERS_API_URL format");
    }

    // Optional settings with defaults
    const username =
        runtime.getSetting("ECHOCHAMBERS_USERNAME") ||
        `agent-${runtime.agentId}`;
    // Change from DEFAULT_ROOM to ROOMS
    const rooms = runtime.getSetting("ECHOCHAMBERS_ROOMS")?.split(",").map(r => r.trim()) || ["general"];

    const pollInterval = Number(
        runtime.getSetting("ECHOCHAMBERS_POLL_INTERVAL") || 120
    );

    if (isNaN(pollInterval) || pollInterval < 1) {
        elizaLogger.error(
            "ECHOCHAMBERS_POLL_INTERVAL must be a positive number in seconds"
        );
        throw new Error("Invalid ECHOCHAMBERS_POLL_INTERVAL");
    }

    elizaLogger.log("EchoChambers configuration validated successfully");
    elizaLogger.log(`API URL: ${apiUrl}`);
    elizaLogger.log(`Username: ${username}`);
    elizaLogger.log(`Watching Rooms: ${rooms.join(", ")}`);
    elizaLogger.log(`Poll Interval: ${pollInterval}s`);
}
