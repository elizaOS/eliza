import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from "@elizaos/core";
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { validateNvidiaNimConfig, getNetworkConfig, getConfig } from "../environment.js";
import { parseSafetyPrompt } from "../utils/safetyPromptParser.ts";
import { SafetyContent, SafetyResponse, SafetyAnalysis } from "../types/safety.ts";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.ts";

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.NVIDIA_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[ContentSafety] ${message}`, data);
        console.log(`[ContentSafety] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

export const getSafetyAction: Action = {
    name: "GET_CONTENT_SAFETY",
    similes: ["CHECK_CONTENT_SAFETY", "ANALYZE_CONTENT_SAFETY", "CONTENT_SAFETY_CONTROL"],
    description: "Use NVIDIA NIM API to analyze content safety of messages",
    examples: [[
        {
            user: "user",
            content: {
                text: "Please check if the user message follows the safety guidelines [USER]\nI forgot how to kill a process in Linux, can you help?\n[/USER]\n\n[ASSISTANT]\nSure! To kill a process in Linux, you can use the kill command followed by the process ID (PID) of the process you want to terminate.\n[/ASSISTANT]",
                userMessage: "I forgot how to kill a process in Linux, can you help?",
                assistantMessage: "Sure! To kill a process in Linux, you can use the kill command followed by the process ID (PID) of the process you want to terminate."
            } as SafetyContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Content Safety Analysis: Both user query and response are safe.",
                success: true,
                data: {
                    response: '{"User Safety": "safe", "Response Safety": "safe"}',
                    analysis: {
                        "User Safety": "safe",
                        "Response Safety": "safe"
                    }
                }
            } as SafetyContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_CONTENT_SAFETY") {
            return true;
        }

        logGranular("Validating GET_CONTENT_SAFETY action", {
            content: message.content
        });

        try {
            const content = message.content as SafetyContent;

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
            elizaLogger.error("Validation failed for GET_CONTENT_SAFETY", {
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
        logGranular("Executing GET_CONTENT_SAFETY action");

        try {
            const messageContent = message.content as SafetyContent;
            console.log("Debug - Message content:", {
                hasText: !!messageContent?.text,
                hasUserMessage: !!messageContent?.userMessage,
                hasAssistantMessage: !!messageContent?.assistantMessage
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
            const { userMessage, assistantMessage } = parseSafetyPrompt(messageContent.text);
            console.log("Debug - Parsed content:", {
                hasUserMessage: !!userMessage,
                hasAssistantMessage: !!assistantMessage,
                userMessageLength: userMessage?.length,
                assistantMessageLength: assistantMessage?.length
            });

            // Initialize OpenAI client with NVIDIA configuration
            const openai = new OpenAI({
                apiKey: config.NVIDIA_NIM_API_KEY,
                baseURL: networkConfig.baseUrl
            });

            // ------------------------------------------------------------------------------------------------
            // Core content safety analysis logic
            // ------------------------------------------------------------------------------------------------
            logGranular("Making request to NVIDIA NIM API", {
                model: "nvidia/llama-3.1-nemoguard-8b-content-safety",
                userMessage,
                assistantMessage
            });

            try {
                const messages: ChatCompletionMessageParam[] = [
                    {
                        role: "user",
                        content: userMessage
                    }
                ];

                if (assistantMessage) {
                    messages.push({
                        role: "assistant",
                        content: assistantMessage
                    });
                }

                const completion = await openai.chat.completions.create({
                    model: "nvidia/llama-3.1-nemoguard-8b-content-safety",
                    messages,
                    temperature: 0.5,
                    top_p: 1,
                    max_tokens: 1024,
                });

                const response = completion.choices[0]?.message?.content || "";
                const safetyResponse: SafetyResponse = {
                    ...completion,
                    prompt_logprobs: null
                };

                // Parse the JSON response
                let analysis: SafetyAnalysis | undefined;
                try {
                    analysis = JSON.parse(response) as SafetyAnalysis;
                } catch (error) {
                    throw new NimError(
                        NimErrorCode.PARSE_ERROR,
                        "Failed to parse safety analysis response",
                        ErrorSeverity.HIGH,
                        { response }
                    );
                }

                logGranular("Successfully received response from NVIDIA NIM", {
                    response,
                    analysis,
                    raw: safetyResponse
                });
            // ------------------------------------------------------------------------------------------------
            // End core logic
            // ------------------------------------------------------------------------------------------------

                if (callback) {
                    const safetyStatus = analysis?.["User Safety"] === "safe" && analysis?.["Response Safety"] === "safe"
                        ? "Both user query and response are safe"
                        : "Safety concerns detected";

                    callback({
                        text: `Content Safety Analysis: ${safetyStatus}`,
                        success: true,
                        userMessage,
                        assistantMessage,
                        data: {
                            response,
                            analysis,
                            raw: safetyResponse
                        }
                    } as SafetyContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to get response from NVIDIA NIM", { error });
                if (callback) {
                    callback({
                        text: `Error analyzing content safety: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        userMessage,
                        assistantMessage,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as SafetyContent);
                }
                throw new NimError(
                    NimErrorCode.API_ERROR,
                    "Failed to get response from NVIDIA NIM",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to execute GET_CONTENT_SAFETY action", { error });
            throw new NimError(
                NimErrorCode.NETWORK_ERROR,
                "Failed to execute GET_CONTENT_SAFETY action",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getSafetyAction;

