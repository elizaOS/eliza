import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
import axios from 'axios';
import { getConfig, validateHyperbolicConfig, HYPERBOLIC_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.HYPERBOLIC_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[GetGpuStatus] ${message}`, data);
        console.log(`[GetGpuStatus] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetGpuStatusContent extends Content {
    text: string;
    instanceId?: string;  // Make instanceId optional since we'll list all instances
    success?: boolean;
    data?: {
        instances?: Array<{
            id: string;
            start: string;
            sshCommand: string;
            instance: {
                status: string;
                hardware: {
                    gpus: Array<{
                        model: string;
                    }>;
                };
                pricing: {
                    price: {
                        amount: number;
                    };
                };
            };
        }>;
        error?: string;
    };
}

export const actionGetGpuStatus: Action = {
    name: "GET_HB_GPU_STATUS",
    similes: ["CHECK_GPU", "GPU_STATUS", "INSTANCE_STATUS", "CHECK_INSTANCE", "LIST_INSTANCES"],
    description: "List all GPU instances or get detailed status information about a specific GPU instance.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Check status of all my GPU instances on Hyperbolic",
            } as GetGpuStatusContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "GPU Instance Status:\nState: Running\nUptime: 2.5 hours\nGPU Utilization: 85%\nMemory Usage: 75%\nTemperature: 65°C\nPower Usage: 250W\n\nRunning Processes:\n- PyTorch Training (PID: 1234): 70% GPU, 8GB Memory\n- TensorFlow Inference (PID: 5678): 15% GPU, 4GB Memory",
                instanceId: "abc123",
                success: true,
                data: {
                    status: {
                        state: "running",
                        uptime: 9000,
                        gpu_utilization: 85,
                        memory_utilization: 75,
                        temperature: 65,
                        power_usage: 250,
                        processes: [
                            {
                                pid: 1234,
                                name: "PyTorch Training",
                                memory_usage: 8192,
                                gpu_usage: 70
                            },
                            {
                                pid: 5678,
                                name: "TensorFlow Inference",
                                memory_usage: 4096,
                                gpu_usage: 15
                            }
                        ]
                    }
                }
            } as GetGpuStatusContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_HB_GPU_STATUS") {
            return true;
        }

        logGranular("Validating GET_HB_GPU_STATUS action", {
            content: message.content
        });

        try {
            const content = message.content as GetGpuStatusContent;
            // instanceId is optional now - if provided, it must be a string
            if (content.instanceId && typeof content.instanceId !== 'string') {
                throw new ValidationError("If provided, Instance ID must be a string");
            }

            logGranular("Validation successful");
            return true;
        } catch (error) {
            logGranular("Validation failed", { error });
            if (error instanceof ValidationError) {
                throw error;
            }
            throw new ValidationError(error instanceof Error ? error.message : "Unknown validation error");
        }
    },

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State,
        _options: { [key: string]: unknown } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        logGranular("Executing GET_HB_GPU_STATUS action");
            // ------------------------------------------------------------------------------------------------
            // Core GPU status check logic
            // ------------------------------------------------------------------------------------------------
        try {
            const config = await validateHyperbolicConfig(runtime);
            console.log("Debug - Config validated:", {
                hasApiKey: !!config.HYPERBOLIC_API_KEY,
                env: config.HYPERBOLIC_ENV
            });

            const apiKey = config.HYPERBOLIC_API_KEY;
            if (!apiKey) {
                throw new ConfigurationError("HYPERBOLIC_API_KEY not found in environment variables");
            }

            const content = message.content as GetGpuStatusContent;
            logGranular("Processing request", { instanceId: content.instanceId });

            try {
                const response = await axios.get(
                    HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].instances.base,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${apiKey}`
                        }
                    }
                );

                logGranular("Received response from API", {
                    statusCode: response.status
                });

                const instances = response.data.instances || [];
                const formattedText = instances.length > 0
                    ? `Your GPU Instances:\n\n${instances.map((instance: {
                        id: string;
                        instance: {
                            status: string;
                            hardware: {
                                gpus: Array<{ model: string }>;
                            };
                            pricing: {
                                price: { amount: number };
                            };
                        };
                        sshCommand: string;
                    }) =>
                        `Instance ID: ${instance.id}\n` +
                        `Status: ${instance.instance.status}\n` +
                        `SSH Access: ${instance.sshCommand}\n` +
                        `GPU: ${instance.instance.hardware.gpus[0].model}\n` +
                        `Price: $${instance.instance.pricing.price.amount}/hour`
                    ).join('\n-------------------\n\n')}`
                    : 'No active GPU instances found.';

                logGranular("Sending success callback with formatted text", { formattedText });

                if (callback) {
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            instances: response.data.instances
                        }
                    } as GetGpuStatusContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    if (error.response?.status === 404) {
                        throw new APIError(
                            `Instance ${content.instanceId} not found or GPU status is not available. Please verify the instance ID and try again.`,
                            404
                        );
                    }
                    throw new APIError(
                        `Failed to fetch GPU status: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch GPU status");
            }
            // ------------------------------------------------------------------------------------------------
            // End core logic
            // ------------------------------------------------------------------------------------------------

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting GPU status: ${errorMessage}`,
                    instanceId: (message.content as GetGpuStatusContent).instanceId,
                    success: false,
                    data: {
                        error: errorMessage
                    }
                } as GetGpuStatusContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_HB_GPU_STATUS action");
        }
    }
};

export default actionGetGpuStatus;
