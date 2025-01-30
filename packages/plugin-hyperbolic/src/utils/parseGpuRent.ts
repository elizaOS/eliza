import { ValidationError } from '../error/base';
import { elizaLogger } from "@elizaos/core";

export interface ParsedGpuRental {
    nodeId: string;
    clusterName: string;
}

/**
 * Parses GPU rental information from [nodeid] and [cluster] tags
 * Format expected:
 * [nodeid]node-id-here[/nodeid]
 * [cluster]cluster-name-here[/cluster]
 *
 * @throws ValidationError if no valid node ID or cluster name is found
 */
export function parseGpuRental(text: string): ParsedGpuRental {
    elizaLogger.info("[GpuRentalParser] Parsing text:", { text });

    try {
        // Check for [nodeid] tag
        const nodeMatch = text.match(/\[nodeid\]([\s\S]*?)\[\/nodeid\]/i);
        if (!nodeMatch) {
            elizaLogger.info("[GpuRentalParser] No [nodeid] tags found in text");
            throw new ValidationError("No [nodeid] tags found. Expected format: [nodeid]node-id[/nodeid]");
        }

        // Check for [cluster] tag
        const clusterMatch = text.match(/\[cluster\]([\s\S]*?)\[\/cluster\]/i);
        if (!clusterMatch) {
            elizaLogger.info("[GpuRentalParser] No [cluster] tags found in text");
            throw new ValidationError("No [cluster] tags found. Expected format: [cluster]cluster-name[/cluster]");
        }

        const nodeId = nodeMatch[1].trim();
        const clusterName = clusterMatch[1].trim();

        if (!nodeId) {
            elizaLogger.info("[GpuRentalParser] Empty node ID in [nodeid] tags");
            throw new ValidationError("Empty node ID in [nodeid] tags");
        }

        if (!clusterName) {
            elizaLogger.info("[GpuRentalParser] Empty cluster name in [cluster] tags");
            throw new ValidationError("Empty cluster name in [cluster] tags");
        }

        elizaLogger.info("[GpuRentalParser] Successfully parsed rental info:", { nodeId, clusterName });

        return {
            nodeId,
            clusterName
        };
    } catch (error) {
        elizaLogger.error("[GpuRentalParser] Parse error:", { error });
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new ValidationError(
            `Failed to parse GPU rental info: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export default parseGpuRental;