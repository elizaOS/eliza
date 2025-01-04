import {
    IAgentRuntime,
    Action,
    Memory,
    State,
    HandlerCallback,
    ActionExample,
    ServiceType,
} from "@elizaos/core";

import { IrysService } from "../services/irysService";

export const retrieveDataAction: Action = {
    name: "RETRIEVE_DATA_FROM_IRYS",
    description: "Retrieve data from Irys for any message",
    similes: ["RETRIEVE_DATA"],
    validate: async (
        _runtime: IAgentRuntime,
        _message: Memory,
    ) => {
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        console.log("Starting RETRIEVE_DATA_FROM_IRYS handler...");
        const irysService: IrysService = runtime.getService(ServiceType.IRYS);
        const agentsWalletPublicKeys = runtime.getSetting("AGENTS_WALLET_PUBLIC_KEYS").split(",");
        const data = await irysService.getDataFromAnAgent(agentsWalletPublicKeys);
        if (!data.success) {
            console.log("Error retrieving data:", data.error);
            return false;
        }
        console.log(`Data retrieved successfully. Data:`);
        console.log(data.data);
        return true;
    },
    examples: [
    ] as ActionExample[][],
}
