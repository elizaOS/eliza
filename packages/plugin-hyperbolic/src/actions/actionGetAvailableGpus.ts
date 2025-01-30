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
        elizaLogger.info(`[GetAvailableGpus] ${message}`, data);
        console.log(`[GetAvailableGpus] ${message}`, data ? JSON.stringify(data, null, 2) : '');
    }
};

interface GetAvailableGpusContent extends Content {
    text: string;
    filters?: Record<string, unknown>;
    success?: boolean;
    data?: {
        gpus: Array<{
            model: string;
            memory: number;
            price: number;
            available: number;
            total: number;
            location: string;
            node_id: string;
            cluster_name: string;
            compute_power: number;
            clock_speed: number;
            storage_capacity: number;
            ram_capacity: number;
            cpu_cores: number;
            status: string;
        }>;
        error?: string;
    };
}

// interface GpuInfo {
//     model: string;
//     memory: number;
//     compute_capability: string;
//     price_per_hour: number;
//     price_per_month: number;
//     availability: boolean;
//     location: string;
//     performance_score: number;
// }

export const actionGetAvailableGpus: Action = {
    name: "GET_HB_AVAILABLE_GPUS",
    similes: ["LIST_GPUS", "SHOW_GPUS", "AVAILABLE_GPUS", "FIND_GPUS"],
    description: "Get all available GPU machines on the Hyperbolic platform with their specifications and pricing.",
    examples: [[
        {
            user: "user",
            content: {
                text: "Show me available GPUs on Hyperbolic",
                filters: {}
            } as GetAvailableGpusContent
        } as ActionExample,
        {
            user: "assistant",
            content: {
                text: "Here are the available GPUs on the Hyperbolic platform:\n\nGPU Model: RTX 4090\nMemory: 24GB\nCompute Capability: 8.9\nPricing: $2.5/hour ($1800/month)\nLocation: US-East\nStatus: ✓ Available\nPerformance Score: 95/100",
                success: true,
                data: {
                    gpus: [{
                        model: "RTX 4090",
                        memory: 24,
                        price: 2.5,
                        available: 8,
                        total: 8,
                        location: "US-East"
                    }]
                }
            } as GetAvailableGpusContent
        } as ActionExample
    ]],

    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
        if (message.content?.type !== "GET_HB_AVAILABLE_GPUS") {
            return true;
        }

        logGranular("Validating GET_HB_AVAILABLE_GPUS action", {
            content: message.content
        });

        try {
            const content = message.content as GetAvailableGpusContent;
            if (content.filters && typeof content.filters !== 'object') {
                throw new ValidationError("Invalid filters format - must be an object");
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
        logGranular("Executing GET_HB_AVAILABLE_GPUS action");
            // ------------------------------------------------------------------------------------------------
            // Core GPU availability check logic
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

            const content = message.content as GetAvailableGpusContent;
            logGranular("Processing request with filters", { filters: content.filters });

            try {
                logGranular("Making request to Hyperbolic marketplace API");
                const response = await axios.post(
                    HYPERBOLIC_ENDPOINTS[config.HYPERBOLIC_ENV].marketplace,
                    { filters: content.filters || {} },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${apiKey}`
                        }
                    }
                );

                logGranular("Received response from API", {
                    statusCode: response.status,
                    dataLength: response.data?.instances?.length
                });

                // Process GPU information from response
                const gpuMap = new Map<string, {
                    model: string;
                    memory: number;
                    price: number;
                    available: number;
                    total: number;
                    location: string;
                    node_id: string;
                    cluster_name: string;
                    compute_power: number;
                    clock_speed: number;
                    storage_capacity: number;
                    ram_capacity: number;
                    cpu_cores: number;
                    status: string;
                }>();

                for (const instance of response.data.instances) {
                    if (instance.status === "node_ready") {
                        const gpu = instance.hardware.gpus[0];
                        const gpuModel = gpu.model.replace("NVIDIA-", "");
                        const memory = Math.round(gpu.ram / 1024); // Convert to GB
                        const price = instance.pricing.price.amount / 100; // Convert to actual dollars
                        const available = instance.gpus_total - instance.gpus_reserved;
                        const total = instance.gpus_total;
                        const location = instance.location.region;

                        // Get additional hardware details
                        const storage = instance.hardware.storage[0]?.capacity || 0;
                        const ram = instance.hardware.ram[0]?.capacity || 0;
                        const cpuCores = instance.hardware.cpus[0]?.virtual_cores || 0;

                        // Create unique key based on model, price, and cluster
                        const key = `${gpuModel}-${price}-${instance.cluster_name}`;

                        if (!gpuMap.has(key)) {
                            gpuMap.set(key, {
                                model: gpuModel,
                                memory,
                                price,
                                available,
                                total,
                                location,
                                node_id: instance.id,
                                cluster_name: instance.cluster_name,
                                compute_power: gpu.compute_power || 0,
                                clock_speed: gpu.clock_speed || 0,
                                storage_capacity: storage,
                                ram_capacity: ram,
                                cpu_cores: cpuCores,
                                status: instance.status
                            });
                        } else {
                            const existing = gpuMap.get(key);
                            if (existing) {
                                existing.available += available;
                                existing.total += total;
                            }
                        }
                    }
                }

                const gpus = Array.from(gpuMap.values());

                // Sort GPUs by price (descending) and availability
                gpus.sort((a, b) => b.price - a.price || b.available - a.available);

                // Format response text with more details
                const formattedText = `Available GPU Types:\n\n${gpus
                    .map(gpu => {
                        const monthlyPrice = Math.round(gpu.price * 24 * 30);
                        const storageGB = Math.round(gpu.storage_capacity / 1024);
                        const ramGB = Math.round(gpu.ram_capacity / 1024);

                        return `${gpu.model} (${gpu.memory}GB):
- Price: $${gpu.price.toFixed(2)}/hour ($${monthlyPrice}/month)
- Available: ${gpu.available}/${gpu.total} units
- Location: ${gpu.location}
- Node ID: ${gpu.node_id}
- Cluster: ${gpu.cluster_name}
- Hardware Specs:
  • CPU: ${gpu.cpu_cores} virtual cores
  • RAM: ${ramGB}GB
  • Storage: ${storageGB}GB
  • GPU Clock: ${gpu.clock_speed}MHz
  • Compute Power: ${gpu.compute_power} TFLOPS
- Status: ${gpu.status}

To rent this GPU, use:
  • Node ID: ${gpu.node_id}
  • Cluster Name: ${gpu.cluster_name}
`;
                    })
                    .join("\n")}

                Note: Use the Node ID and Cluster Name when creating an instance. These are the unique identifiers required for the rental process.`;

                if (callback) {
                    logGranular("Sending success callback with formatted text", { formattedText });
                    callback({
                        text: formattedText,
                        success: true,
                        data: {
                            gpus: gpus
                        }
                    } as GetAvailableGpusContent);
                }

                return true;

            } catch (error) {
                logGranular("API request failed", { error });
                if (axios.isAxiosError(error)) {
                    throw new APIError(
                        `Failed to fetch GPU data: ${error.message}`,
                        error.response?.status
                    );
                }
                throw new APIError("Failed to fetch GPU data");
            }

        } catch (error) {
            logGranular("Handler execution failed", { error });

            if (callback) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
                callback({
                    text: `Error getting available GPUs: ${errorMessage}`,
                    success: false,
                    data: {
                        gpus: [],
                        error: errorMessage
                    }
                } as GetAvailableGpusContent);
            }

            if (error instanceof ConfigurationError ||
                error instanceof ValidationError ||
                error instanceof APIError) {
                throw error;
            }

            throw new APIError("Failed to execute GET_HB_AVAILABLE_GPUS action");
        }
    }
};

export default actionGetAvailableGpus;
