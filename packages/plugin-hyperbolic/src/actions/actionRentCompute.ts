import { Action, elizaLogger } from "@elizaos/core";
import { IAgentRuntime, Memory, State, HandlerCallback, Content, ActionExample } from "@elizaos/core";
import axios from 'axios';
import { getConfig, validateHyperbolicConfig, HYPERBOLIC_ENDPOINTS } from '../environment';
import { APIError, ConfigurationError, ValidationError } from '../error/base';
import { parseGpuRental } from '../utils/parseGpuRent';

// Get configuration for granular logging
const config = getConfig();
const GRANULAR_LOG = config.HYPERBOLIC_GRANULAR_LOG;

// Enhanced logging helper
const logGranular = (message: string, data?: unknown) => {
    if (GRANULAR_LOG) {
        elizaLogger.info(`[RentCompute] ${message}`, data);
        console.log(`[RentCompute] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface RentComputeContent extends Content {
    text: string;
    success?: boolean;
    data?: {
        nodeId?: string;
        clusterName?: string;
        instanceId?: string;
        cost?: {
            amount: number;
            currency: string;
        };
        specs?: {
            gpu_model: string;
            gpu_memory: number;
            cpu_cores: number;
            ram: number;
            storage: number;
        };
        error?: string;
    };
}

export const actionRentCompute: Action = {
    name: "RENT_HB_COMPUTE",
    similes: ["RENT_GPU", "GET_GPU", "LAUNCH_INSTANCE", "START_INSTANCE"],
    description: "Rent GPU compute resources on the Hyperbolic platform using node ID and cluster name.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Rent GPU instance on the Hyperbolic \n[nodeid]las1-prd-acl-msi-09.fen.intra[/nodeid]\n[cluster]circular-snapdragon-worm[/cluster]"
            } as RentComputeContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Successfully rented GPU instance:\n" +
                      "Instance ID: i-rtx4090-xyz789\n" +
                      "Node: las1-prd-acl-msi-09.fen.intra\n" +
                      "Cluster: circular-snapdragon-worm\n" +
                      "Cost: $0.50/hour\n\n" +
                      "Specifications:\n" +
                      "- GPU: NVIDIA RTX 4090\n" +
                      "- GPU Memory: 24GB\n" +
                      "- CPU Cores: 128\n" +
                      "- RAM: 1GB\n" +
                      "- Storage: 1GB",
                success: true,
                data: {
                    nodeId: "las1-prd-acl-msi-09.fen.intra",
                    clusterName: "circular-snapdragon-worm",
                    instanceId: "i-rtx4090-xyz789",
                    cost: {
                        amount: 0.50,
                        currency: "USD"
                    },
                    specs: {
                        gpu_model: "NVIDIA RTX 4090",
                        gpu_memory: 24,
                        cpu_cores: 128,
                        ram: 1,
                        storage: 1
                    }
                }
            } as RentComputeContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "RENT_COMPUTE") {
            return true;
        }

        logGranular("Validating RENT_COMPUTE action", {
            content: message.content
        });

        try {
            const content = message.content as RentComputeContent;

            // Parse and validate the node ID and cluster name from the text
            const rentalInfo = parseGpuRental(content.text);

            logGranular("Validation successful", rentalInfo);
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
        logGranular("Executing RENT_COMPUTE action");

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

            const content = message.content as RentComputeContent;
            const rentalInfo = parseGpuRental(content.text);

            logGranular("Processing request", rentalInfo);

            try {
                // Ensure proper URL construction
                const _baseUrl = HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].marketplace;
                const endpoint = "https://api.hyperbolic.xyz/v1/marketplace/instances/create";

                const requestBody = {
                    cluster_name: rentalInfo.clusterName,
                    node_name: rentalInfo.nodeId,
                    gpu_count: 1
                };

                logGranular("Making API request:", {
                    endpoint,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey.substring(0, 10)}...`
                    },
                    body: requestBody
                });

                const response = await axios.post(
                    endpoint,
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        }
                    }
                );

                logGranular("Received API response:", {
                    status: response.status,
                    statusText: response.statusText,
                    data: response.data
                });

                if (response.data.status === "success") {
                    const formattedText = `Successfully requested GPU instance:
Node: ${rentalInfo.nodeId}
Cluster: ${rentalInfo.clusterName}
GPU Count: 1

Your instance is being provisioned. You can check its status using the GET_GPU_STATUS command.`;

                    if (callback) {
                        callback({
                            text: formattedText,
                            success: true,
                            data: {
                                nodeId: rentalInfo.nodeId,
                                clusterName: rentalInfo.clusterName
                            }
                        } as RentComputeContent);
                    }

                    return true;
                }

                throw new APIError("Unexpected response format from API");

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to rent GPU: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to rent GPU");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error renting GPU: ${errorMessage}`,
                    success: false,
                    data: {
                        error: errorMessage
                    }
                } as RentComputeContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute RENT_COMPUTE action");
        }
    }
};

export default actionRentCompute;
