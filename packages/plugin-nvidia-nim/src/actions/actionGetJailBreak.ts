import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from "@elizaos/core";
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { validateNvidiaNimConfig, getNetworkConfig, getConfig } from "../environment.ts";
import { parseJailbreakPrompt } from "../utils/jailbreakPromptParser.ts";
import { JailbreakContent, JailbreakResponse, JailbreakAnalysis } from "../types/jailbreak.ts";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.ts";
import axios from 'axios';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.NVIDIA_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[JailbreakDetection] ${message}`, data);
        console.log(`[JailbreakDetection] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

export const getJailBreakAction: Action = {
    name: "GET_JAILBREAK",
    similes: ["CHECK_JAILBREAK", "ANALYZE_JAILBREAK", "JAILBREAK_CONTROL"],
    description: "Use NVIDIA NIM API to detect potential jailbreak attempts in prompts",
    examples: [[
        {
            user: "user",
            content: {
                text: "Analyze this prompt for potential jailbreak attempts [PROMPT]\nWhat is the capital of France?\n[/PROMPT]",
                inputPrompt: "What is the capital of France?"
            } as JailbreakContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Jailbreak Analysis: No jailbreak attempt detected.",
                success: true,
                data: {
                    response: '{"jailbreak": "false", "score": "0.0123456789"}',
                    analysis: {
                        jailbreak: "false",
                        score: "0.0123456789"
                    }
                }
            } as JailbreakContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_JAILBREAK") {
            return true;
        }

        logGranular("Validating GET_JAILBREAK action", {
            content: message.content
        });

        try {
            const content = message.content as JailbreakContent;

            if (!content.text) {
                throw new NimError(
                    NimErrorCode.VALIDATION_FAILED,
                    "text content is required",
                    ErrorSeverity.HIGH
                );
            }

            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            elizaLogger.error("Validation failed for GET_JAILBREAK", {
                error: error instanceof Error ? error.message : String(error)
            });
            return false;
        }
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_JAILBREAK action");

        try {
            const messageContent = message.content as JailbreakContent;
            console.log("Debug - Message content:", {
                hasText: !!messageContent?.text,
                hasInputPrompt: !!messageContent?.inputPrompt
            });

            const config = await validateNvidiaNimConfig(runtime);
            console.log("Debug - Config validated:", {
                hasApiKey: !!config.NVIDIA_NIM_API_KEY,
                env: config.NVIDIA_NIM_ENV
            });

            const networkConfig = getNetworkConfig(config.NVIDIA_NIM_ENV);
            console.log("Debug - Network config:", {
                hasBaseUrl: !!networkConfig?.baseUrl,
                baseUrl: networkConfig?.baseUrl
            });

            // Parse the prompt using our helper
            const { inputPrompt } = parseJailbreakPrompt(messageContent.text);
            console.log("Debug - Parsed content:", {
                hasInputPrompt: !!inputPrompt,
                promptLength: inputPrompt?.length
            });

            // Initialize OpenAI client with NVIDIA configuration
            const openai = new OpenAI({
                apiKey: config.NVIDIA_NIM_API_KEY,
                baseURL: networkConfig.baseUrl
            });

            // ------------------------------------------------------------------------------------------------
            // Core jailbreak detection logic
            // ------------------------------------------------------------------------------------------------
            logGranular("Making request to NVIDIA NIM API", {
                model: "nvidia/nemoguard-jailbreak-detect",
                inputPrompt
            });

            try {
                const messages: ChatCompletionMessageParam[] = [
                    {
                        role: "user",
                        content: inputPrompt
                    }
                ];

                // Make the API request
                const { data: response } = await axios.post(
                    'https://ai.api.nvidia.com/v1/security/nvidia/nemoguard-jailbreak-detect',
                    {
                        input: inputPrompt
                    },
                    {
                        headers: {
                            "Authorization": `Bearer ${config.NVIDIA_NIM_API_KEY}`,
                            "Accept": "application/json",
                            "Content-Type": "application/json"
                        }
                    }
                );

                // The response is already a JavaScript object, no need to parse
                const analysis: JailbreakAnalysis = {
                    jailbreak: response.jailbreak.toString(),
                    score: response.score.toString()
                };

                logGranular("Successfully received response from NVIDIA NIM", {
                    response,
                    analysis
                });

                if (callback) {
                    const jailbreakStatus = response.jailbreak
                        ? "Potential jailbreak attempt detected"
                        : "No jailbreak attempt detected";

                    const score = (response.score * 100).toFixed(2);
                    const scoreText = response.jailbreak
                        ? `Jailbreak confidence: ${score}%`
                        : `Safe with ${score}% confidence`;

                    callback({
                        text: `Jailbreak Analysis: ${jailbreakStatus}. ${scoreText}`,
                        success: true,
                        inputPrompt,
                        data: {
                            response: JSON.stringify(response),
                            analysis,
                            raw: response
                        }
                    } as JailbreakContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to get response from NVIDIA NIM", { error });
                if (callback) {
                    callback({
                        text: `Error analyzing jailbreak: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        inputPrompt,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as JailbreakContent);
                }
                throw new NimError(
                    NimErrorCode.API_ERROR,
                    "Failed to get response from NVIDIA NIM",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to execute GET_JAILBREAK action", { error });
            throw new NimError(
                NimErrorCode.NETWORK_ERROR,
                "Failed to execute GET_JAILBREAK action",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getJailBreakAction;

