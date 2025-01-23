import {
    type Provider,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { createSession, getSessionDetails, sendMessage } from "./devinRequests";

/**
 * Interface representing the state of a Devin session in the provider
 */
export interface DevinState {
    sessionId?: string;
    status?: "running" | "blocked" | "stopped";
    lastUpdate?: number;
    error?: string;
    structured_output?: Record<string, unknown>;
    url?: string;
}

/**
 * Provider for interacting with the Devin API
 * Manages session state and provides methods for creating sessions and sending messages
 */
export const devinProvider: Provider = {
    get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
        try {
            const API_KEY = runtime.getSetting("DEVIN_API_TOKEN");
            if (!API_KEY) {
                elizaLogger.error("No Devin API token found");
                return {
                    error: "No Devin API token found",
                    lastUpdate: Date.now(),
                };
            }

            const devinState = (state?.devin || {}) as DevinState;
            
            // If we have an active session, get its status
            if (devinState.sessionId) {
                try {
                    const sessionDetails = await getSessionDetails(runtime, devinState.sessionId);
                    return {
                        sessionId: sessionDetails.session_id,
                        status: sessionDetails.status_enum,
                        url: sessionDetails.url,
                        lastUpdate: Date.now(),
                        structured_output: sessionDetails.structured_output,
                    };
                } catch (error) {
                    elizaLogger.error("Error fetching session details:", error);
                    return {
                        error: "Failed to fetch session details",
                        lastUpdate: Date.now(),
                        sessionId: devinState.sessionId, // Keep the session ID for reference
                    };
                }
            }

            // No active session
            return {
                lastUpdate: Date.now(),
            };
        } catch (error) {
            elizaLogger.error("Error in devinProvider:", error);
            return {
                error: "Internal provider error",
                lastUpdate: Date.now(),
            };
        }
    },
};
