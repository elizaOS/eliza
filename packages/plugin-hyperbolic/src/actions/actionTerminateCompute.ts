import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
import axios from 'axios';
import { getConfig, validateHyperbolicConfig, HYPERBOLIC_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';
import { parseGpuInstance } from '../utils/parseGpuInstance';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.HYPERBOLIC_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[TerminateCompute] ${message}`, data);
        console.log(`[TerminateCompute] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface TerminateComputeContent extends Content {
    text: string;
    instanceId: string;
    market?: string;
    success?: boolean;
    data?: {
        terminationStatus?: {
            status: string;
            message: string;
            error_code?: number;
        };
        error?: string;
    };
}

export const actionTerminateCompute: Action = {
    name: "TERMINATE_HB_COMPUTE",
    similes: ["STOP_GPU", "TERMINATE_INSTANCE", "STOP_INSTANCE"],
    description: "Terminate a running GPU compute instance on Hyperbolic",
    examples: [[
        {
            user: "user",
            content: {
                text: "Terminate GPU instance [gpu]worse-walnut-viper[/gpu] on Hyperbolic",
                instanceId: "worse-walnut-viper",
                market: "Hyperbolic"
            } as TerminateComputeContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Successfully initiated termination of GPU instance worse-walnut-viper on Hyperbolic",
                instanceId: "worse-walnut-viper",
                market: "Hyperbolic",
                success: true,
                data: {
                    terminationStatus: {
                        status: "success",
                        message: "Termination initiated"
                    }
                }
            } as TerminateComputeContent
        } as ActionExample
    ], [
        {
            user: "user",
            content: {
                text: "Terminate the Hyperbolic instance [gpu]worse-walnut-viper[/gpu]",
                instanceId: "worse-walnut-viper",
                market: "gpu"
            } as TerminateComputeContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Successfully initiated termination of GPU instance worse-walnut-viper on gpu marketplace",
                instanceId: "worse-walnut-viper",
                market: "gpu",
                success: true,
                data: {
                    terminationStatus: {
                        status: "success",
                        message: "Termination initiated"
                    }
                }
            } as TerminateComputeContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        logGranular("Starting validation", {
            messageText: message.content?.text,
            type: message.content?.type
        });

        // Check if this is our action type
        if (!message.content?.type || message.content.type !== "TERMINATE_HB_COMPUTE") {
            return true;
        }

        if (!message.content.text) {
            throw new ValidationError("No text provided to parse instance ID");
        }

        try {
            // Just verify we can parse the instance ID
            const parsed = parseGpuInstance(message.content.text);
            logGranular("Successfully parsed instance ID", {
                instanceId: parsed.instanceId,
                market: parsed.market
            });
            return true;
        } catch (error) {
            logGranular("Failed to parse instance ID", { error });
            throw new ValidationError(error instanceof Error ? error.message : "Could not parse instance ID from text");
        }
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing TERMINATE_HB_COMPUTE action");
        try {
            const config = await validateHyperbolicConfig(runtime);
            const apiKey = config.HYPERBOLIC_API_KEY;
            if (!apiKey) {
                throw new ConfigurationError("HYPERBOLIC_API_KEY not found in environment variables");
            }

            // Parse the instance ID directly from text
            const parsed = parseGpuInstance(message.content?.text || "");
            logGranular("Parsed instance details", {
                instanceId: parsed.instanceId,
                market: parsed.market
            });

            try {
                const requestBody = { id: parsed.instanceId };
                logGranular("Sending termination request", {
                    endpoint: HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].instances.terminate,
                    requestBody
                });

                const response = await axios.post(
                    HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].instances.terminate,
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`
                        }
                    }
                );

                logGranular("Received response from API", {
                    statusCode: response.status,
                    data: response.data
                });

                const formattedText = `Successfully initiated termination of GPU instance ${parsed.instanceId}`;

                if (callback) {
                    callback({
                        text: formattedText,
                        instanceId: parsed.instanceId,
                        market: parsed.market,
                        success: true,
                        data: {
                            terminationStatus: {
                                status: "success",
                                message: "Termination initiated"
                            }
                        }
                    } as TerminateComputeContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    const errorCode = error.response?.data?.error_code;
                    const errorMessage = error.response?.data?.message || error.message;

                    if (errorCode === 105) {
                        throw new APIError(`Instance not found: ${parsed.instanceId}`, 404);
                    }

                    throw new APIError(
                        `Failed to terminate instance: ${errorMessage}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to terminate instance");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error terminating instance: ${errorMessage}`,
                    instanceId: (message.content as TerminateComputeContent).instanceId,
                    success: false,
                    data: {
                        terminationStatus: {
                            status: "error",
                            message: errorMessage,
                            error_code: (error as APIError).statusCode || 500
                        }
                    }
                } as TerminateComputeContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute TERMINATE_HB_COMPUTE action");
        }
    }
};

export default actionTerminateCompute;
