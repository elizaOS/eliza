import { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { zerionProvider } from "../../providers/index.ts";
import { PositionData } from "../../types.ts";
import { formatPositionsData } from "../../utils.ts";
import examples from "./examples.ts";

export const getWalletPositions: Action = {
    name: "getwallet_positions",
    description: "Fetch a wallet's token positions from Zerion for an address",
    examples,
    similes: [
        "getwallet_positions",
        "displaypositions",
        "getwallet_tokens",
        "get_token_positions",
        "get wallet positions",
        "get wallet tokens",
        "get token positions",
        "list tokens",
    ],
    validate: async (_runtime: IAgentRuntime, message: Memory) => {
        const addressRegex = /0x[a-fA-F0-9]{40}/;
        return addressRegex.test(message.content.text);
    },
    handler: async (runtime: IAgentRuntime, message: Memory, _state?: State, _options?: { [key: string]: unknown; }, callback?: HandlerCallback): Promise<boolean> => {

        const response = await zerionProvider.getPositions(runtime, message);
        console.log("ZERION positions API response: ", response);
        if (!response.success || !response.data) {
            return false;
        }

        console.log("ZERION API response: ", response);

        // format response into a message string;
        const formattedResponse = formatPositionsData(response.data as PositionData);

        if (callback) {
            console.log("sending response to callback");
            callback({
                text: formattedResponse,
                content: {
                    ...response.data
                }
            })
        }
        return true;
    }
}