import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from "@elizaos/core";
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { validateNvidiaNimConfig, getNetworkConfig, getConfig } from "../environment.js";
import { parseOffTopicPrompt } from "../utils/offTopicPromptParser.js";
import { OffTopicContent, OffTopicResponse } from "../types/offTopic.js";
import { NimError, NimErrorCode, ErrorSeverity } from "../errors/nimErrors.js";

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.NVIDIA_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[TopicControl] ${message}`, data);
        console.log(`[TopicControl] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};
// Action definition
export const getTopicAction: Action = {
    name: "GET_OFFTOPIC",
    similes: ["CHECK_OFFTOPIC", "ANALYZE_OFFTOPIC", "OFFTOPIC_CONTROL"],
    description: "Use NVIDIA NIM API to analyze and control off-topic relevance",
    examples: [[
        {
            user: "user",
            content: {
                text: "Check if the user message is on-topic or off-topic [SYSTEM]\nYou are to act as an investor relations topic control system. Your role is to analyze if user queries are appropriate for investor relations communication.\n[/SYSTEM]\n\n[USER]\nCan you speculate on the potential impact of a recession on ABCs business?\n[/USER]",
                userMessage: "Can you speculate on the potential impact of a recession on ABCs business?"
            } as OffTopicContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Off-topic analysis: The message is off-topic as it requests speculation about future business impacts, which is not appropriate for investor relations communication.",
                success: true,
                data: {
                    response: "off-topic"
                }
            } as OffTopicContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_OFFTOPIC") {
            return true;
        }

        logGranular("Validating GET_OFFTOPIC action", {
            content: message.content
        });

        try {
            const content = message.content as OffTopicContent;

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
            elizaLogger.error("Validation failed for GET_OFFTOPIC", {
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
        logGranular("Executing GET_OFFTOPIC action");

        try {
            const messageContent = message.content as OffTopicContent;
            console.log("Debug - Message content:", {
                hasText: !!messageContent?.text,
                hasUserMessage: !!messageContent?.userMessage
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
            const { systemContent, userContent } = parseOffTopicPrompt(
                messageContent.text,
                config.NVIDIA_OFFTOPIC_SYSTEM || "",
                messageContent.userMessage || config.NVIDIA_OFFTOPIC_USER || ""
            );

            console.log("Debug - Parsed content:", {
                hasSystemContent: !!systemContent,
                hasUserContent: !!userContent
            });

            // Initialize OpenAI client with NVIDIA configuration
            const openai = new OpenAI({
                apiKey: config.NVIDIA_NIM_API_KEY,
                baseURL: networkConfig.baseUrl
            });

            // ------------------------------------------------------------------------------------------------
            // Core off-topic analysis logic
            // ------------------------------------------------------------------------------------------------
            logGranular("Making request to NVIDIA NIM API", {
                model: "nvidia/llama-3.1-nemoguard-8b-topic-control",
                systemContent,
                userContent
            });

            try {
                const messages: ChatCompletionMessageParam[] = [
                    {
                        role: "system",
                        content: systemContent
                    },
                    {
                        role: "user",
                        content: userContent
                    }
                ];

                const completion = await openai.chat.completions.create({
                    model: "nvidia/llama-3.1-nemoguard-8b-topic-control",
                    messages,
                    temperature: 0.5,
                    top_p: 1,
                    max_tokens: 1024,
                });

                const response = completion.choices[0]?.message?.content || "";
                const offTopicResponse: OffTopicResponse = {
                    ...completion,
                    prompt_logprobs: null
                };

                logGranular("Successfully received response from NVIDIA NIM", {
                    response,
                    raw: offTopicResponse
                });
            // ------------------------------------------------------------------------------------------------
            // End core logic
            // ------------------------------------------------------------------------------------------------
            // Callback to the framework to return the response
            // ------------------------------------------------------------------------------------------------
                if (callback) {
                    callback({
                        text: messageContent.text,
                        userMessage: messageContent.userMessage,
                        success: true
                    } as OffTopicContent);
                }

                if (callback) {
                    callback({
                        text: `Off-Topic Analysis: ${response}`,
                        success: true,
                        userMessage: messageContent.userMessage,
                        data: {
                            response,
                            raw: offTopicResponse
                        }
                    } as OffTopicContent);
                }

                return true;
            } catch (error) {
                logGranular("Failed to get response from NVIDIA NIM", { error });
                if (callback) {
                    callback({
                        text: `Error analyzing off-topic content: ${error instanceof Error ? error.message : String(error)}`,
                        success: false,
                        userMessage: messageContent.userMessage,
                        data: {
                            error: error instanceof Error ? error.message : String(error)
                        }
                    } as OffTopicContent);
                }
                throw new NimError(
                    NimErrorCode.API_ERROR,
                    "Failed to get response from NVIDIA NIM",
                    ErrorSeverity.HIGH,
                    { originalError: error }
                );
            }
        } catch (error) {
            logGranular("Failed to execute GET_OFFTOPIC action", { error });
            throw new NimError(
                NimErrorCode.NETWORK_ERROR,
                "Failed to execute GET_OFFTOPIC action",
                ErrorSeverity.HIGH,
                { originalError: error }
            );
        }
    }
};

export default getTopicAction;

