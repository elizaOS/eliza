import { ValidationError } from '../error/base';
import { elizaLogger } from "@elizaos/core";

export interface ParsedGpuInstance {
    instanceId: string;
    market?: string;
}

/**
 * Parses a GPU instance ID from [gpu] tags
 * Format expected:
 * [gpu]instance-id[/gpu]
 *
 * @throws ValidationError if no valid instance ID is found
 */
export function parseGpuInstance(text: string): ParsedGpuInstance {
    elizaLogger.info("[GpuParser] Parsing text:", { text });

    try {
        // Only check for [gpu] tag format
        const tagMatch = text.match(/\[gpu\]([\s\S]*?)\[\/gpu\]/i);
        if (!tagMatch) {
            elizaLogger.info("[GpuParser] No [gpu] tags found in text");
            throw new ValidationError("No [gpu] tags found. Expected format: [gpu]instance-id[/gpu]");
        }

        const instanceId = tagMatch[1].trim();
        if (!instanceId) {
            elizaLogger.info("[GpuParser] Empty instance ID in [gpu] tags");
            throw new ValidationError("Empty instance ID in [gpu] tags");
        }

        elizaLogger.info("[GpuParser] Successfully parsed instance ID:", { instanceId });

        return {
            instanceId,
            market: "gpu"
        };
    } catch (error) {
        elizaLogger.error("[GpuParser] Parse error:", { error });
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new ValidationError(
            `Failed to parse GPU instance: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export default parseGpuInstance;