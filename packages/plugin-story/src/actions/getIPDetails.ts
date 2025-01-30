import {
    composeContext,
    elizaLogger,
    generateObjectDeprecated,
    type HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { getIPDetailsTemplate } from "../templates";
import type { Address } from "viem";
import { type Asset, RESOURCE_TYPE } from "../types/api";
import { API_URL, getResource } from "../lib/api";

export { getIPDetailsTemplate };

// Types for the action parameters and response
type GetIPDetailsParams = {
    ipId: Address;
};

type GetIPDetailsResponse = {
    data: Asset;
};

/**
 * Class handling IP details retrieval from Story Protocol
 */
class GetIPDetailsAction {
    async getIPDetails(
        params: GetIPDetailsParams
    ): Promise<GetIPDetailsResponse> {
        elizaLogger.log("Fetching from", `${API_URL}/${RESOURCE_TYPE.ASSET}`);
        return (await getResource(
            RESOURCE_TYPE.ASSET,
            params.ipId
        )) as GetIPDetailsResponse;
    }
}

/**
 * Formats IP asset details into a readable string
 */
const formatIPDetails = (data: Asset): string => `IP Asset Details:
ID: ${data.id}
NFT Name: ${data.nftMetadata.name}
Token Contract: ${data.nftMetadata.tokenContract}
Token ID: ${data.nftMetadata.tokenId}
Image URL: ${data.nftMetadata.imageUrl}

Relationships:
• Ancestors: ${data.ancestorCount}
• Descendants: ${data.descendantCount}
• Parents: ${data.parentCount || 0}
• Children: ${data.childCount || 0}
• Roots: ${data.rootCount || 0}

Created:
Block #${data.blockNumber}
Timestamp: ${data.blockTimestamp}`;

/**
 * Main action configuration for getting IP details
 */
export const getIPDetailsAction = {
    name: "GET_IP_DETAILS",
    description: "Get details for an IP Asset on Story",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting GET_IP_DETAILS handler...");

        // Initialize or update state
            let currentState = state;
            if (!currentState) {
            currentState = (await runtime.composeState(message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        // Generate content using template
        const content = await generateObjectDeprecated({
            runtime,
            context: composeContext({ state: currentState, template: getIPDetailsTemplate }),
            modelClass: ModelClass.SMALL,
        });

        // Fetch and format IP details
        const action = new GetIPDetailsAction();
        try {
            const response = await action.getIPDetails(content);
            const formattedResponse = formatIPDetails(response.data);

            callback?.({
                text: formattedResponse,
                action: "GET_IP_DETAILS",
                source: "Story Protocol API",
            });
            return true;
        } catch (e) {
            elizaLogger.error("Error fetching IP details:", e.message);
            callback?.({
                text: `Error fetching IP details: ${e.message}`,
            });
            return false;
        }
    },
    template: getIPDetailsTemplate,
    validate: async () => true,
    // Example usage of the action
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get details for an IP Asset 0x2265F2b8e47F98b3Bdf7a1937EAc27282954A4Db",
                    action: "GET_IP_DETAILS",
                },
            },
        ],
    ],
    similes: ["IP_DETAILS", "IP_DETAILS_FOR_ASSET", "IP_DETAILS_FOR_IP"],
};
