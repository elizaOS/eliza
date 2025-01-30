import axios, { type AxiosRequestConfig } from "axios";

export const DEFAULT_MODEL = process.env.OPENAI_DEFAULT_MODEL || "text-davinci-003";
export const DEFAULT_MAX_TOKENS = Number.parseInt(process.env.OPENAI_MAX_TOKENS || "200", 10);
export const DEFAULT_TEMPERATURE = Number.parseFloat(process.env.OPENAI_TEMPERATURE || "0.7");
export const DEFAULT_TIMEOUT = 30000; // 30 seconds

/**
 * Validate a prompt for length and content.
 * @param prompt - The prompt to validate.
 * @throws Will throw an error if the prompt is invalid.
 */
export function validatePrompt(prompt: string): void {
    if (!prompt.trim()) {
        throw new Error("Prompt cannot be empty");
    }
    if (prompt.length > 4000) {
        throw new Error("Prompt exceeds maximum length of 4000 characters");
    }
}

/**
 * Validate the presence of the OpenAI API key.
 * @throws Will throw an error if the API key is not set.
 * @returns The API key.
 */
export function validateApiKey(): string {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("OpenAI API key is not set");
    }
    return apiKey;
}

/**
 * Send a request to the OpenAI API.
 * @param url - The OpenAI API endpoint.
 * @param data - The request payload.
 * @returns The response data.
 * @throws Will throw an error for request failures or rate limits.
 */

export interface OpenAIRequestData {
    model: string;
    prompt: string;
    max_tokens: number;
    temperature: number;
    [key: string]: unknown;
}

export interface OpenAIEditRequestData {
    model: string;
    input: string;
    instruction: string;
    max_tokens: number;
    temperature: number;
    [key: string]: unknown;
}

export async function callOpenAiApi<T>(
    url: string,
    data: OpenAIRequestData | OpenAIEditRequestData,
    apiKey: string,
): Promise<T> {
    try {
        const config: AxiosRequestConfig = {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            timeout: DEFAULT_TIMEOUT,
        };
        const response = await axios.post<T>(url, data, config);
        return response.data;
    } catch (error) {
        console.error("Error communicating with OpenAI API:", error instanceof Error ? error.message : String(error));
        if (axios.isAxiosError(error)) {
            if (error.response?.status === 429) {
                throw new Error("Rate limit exceeded. Please try again later.");
            }
        }
        throw new Error("Failed to communicate with OpenAI API");
    }
}

/**
 * Build a request object for OpenAI completions.
 * @param prompt - The text prompt to process.
 * @param model - The model to use.
 * @param maxTokens - The maximum number of tokens to generate.
 * @param temperature - The sampling temperature.
 * @returns The request payload for OpenAI completions.
 */

export function buildRequestData(
    prompt: string,
    model: string = DEFAULT_MODEL,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    temperature: number = DEFAULT_TEMPERATURE,
): OpenAIRequestData {
    return {
        model,
        prompt,
        max_tokens: maxTokens,
        temperature,
    };
}
