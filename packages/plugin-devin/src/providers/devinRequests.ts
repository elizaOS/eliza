import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import fetch from "node-fetch";

const API_BASE = "https://api.devin.ai/v1";
const MIN_REQUEST_INTERVAL = 1000; // 1 second for rate limiting
const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 1000; // 1 second initial backoff

let lastRequestTime = 0;

/**
 * Interface representing a Devin session
 */
export interface DevinSession {
    session_id: string;
    url: string;
    status_enum: "running" | "blocked" | "stopped";
    structured_output?: Record<string, unknown>;
}

/**
 * Interface representing an error response from the Devin API
 */
interface DevinError {
    error: string;
    message: string;
    status: number;
}

/**
 * Rate limiting function to prevent API abuse
 * Ensures at least MIN_REQUEST_INTERVAL milliseconds between requests
 */
async function rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    lastRequestTime = Date.now();
}

/**
 * Helper function to implement exponential backoff for API requests
 * @param fn The async function to retry
 * @param retries Maximum number of retries
 * @param backoff Initial backoff in milliseconds
 * @returns The result of the async function
 * @throws The last error encountered
 */
async function withRetry<T>(
    fn: () => Promise<T>,
    retries = MAX_RETRIES,
    backoff = INITIAL_BACKOFF
): Promise<T> {
    try {
        return await fn();
    } catch (error) {
        if (retries === 0) throw error;
        
        await new Promise(resolve => setTimeout(resolve, backoff));
        return withRetry(fn, retries - 1, backoff * 2);
    }
}
// Implementation moved to the top of the file

/**
 * Creates a new Devin session with the given prompt
 * @param runtime The Eliza runtime instance
 * @param prompt The prompt to start the session with
 * @returns The created session details
 * @throws {Error} If API token is missing or API request fails
 */
export async function createSession(runtime: IAgentRuntime, prompt: string): Promise<DevinSession> {
    const API_KEY = runtime.getSetting("DEVIN_API_TOKEN");
    if (!API_KEY) {
        const error = new Error("No Devin API token found") as Error & { status?: number };
        error.status = 401;
        throw error;
    }

    await rateLimit();
    return withRetry(async () => {
        const response = await fetch(`${API_BASE}/sessions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
            const error = await response.text();
            elizaLogger.error("Failed to create Devin session:", error);
            throw new Error(`Failed to create session: ${error}`);
        }

        const data = await response.json();
        return data as DevinSession;
    });
}

/**
 * Retrieves details for an existing Devin session
 * @param runtime The Eliza runtime instance
 * @param sessionId The ID of the session to retrieve
 * @returns The session details
 * @throws {Error} If API token is missing or API request fails
 */
export async function getSessionDetails(runtime: IAgentRuntime, sessionId: string): Promise<DevinSession> {
    const API_KEY = runtime.getSetting("DEVIN_API_TOKEN");
    if (!API_KEY) {
        const error = new Error("No Devin API token found") as Error & { status?: number };
        error.status = 401;
        throw error;
    }

    await rateLimit();
    return withRetry(async () => {
        const response = await fetch(`${API_BASE}/session/${sessionId}`, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
            },
        });

        if (!response.ok) {
            const error = await response.text();
            elizaLogger.error("Failed to get session details:", error);
            const apiError = new Error(`Failed to get session details: ${error}`) as Error & { status?: number };
            apiError.status = response.status;
            throw apiError;
        }

        const data = await response.json();
        return data as DevinSession;
    });
}

/**
 * Sends a message to an existing Devin session
 * @param runtime The Eliza runtime instance
 * @param sessionId The ID of the session to send the message to
 * @param message The message content to send
 * @throws {Error} If API token is missing or API request fails
 */
export async function sendMessage(runtime: IAgentRuntime, sessionId: string, message: string): Promise<void> {
    const API_KEY = runtime.getSetting("DEVIN_API_TOKEN");
    if (!API_KEY) {
        const error = new Error("No Devin API token found") as Error & { status?: number };
        error.status = 401;
        throw error;
    }

    await rateLimit();
    return withRetry(async () => {
        const response = await fetch(`${API_BASE}/session/${sessionId}/message`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ message }),
        });

        if (!response.ok) {
            const error = await response.text();
            elizaLogger.error("Failed to send message:", error);
            const apiError = new Error(`Failed to send message: ${error}`) as Error & { status?: number };
            apiError.status = response.status;
            throw apiError;
        }
    });
}
