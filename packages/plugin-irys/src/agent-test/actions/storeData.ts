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

export const storeDataAction: Action = {
    name: "STORE_DATA_ON_IRYS",
    description: "Store data on Irys for any message",
    similes: ["DEFAULT_ACTION", "ANY_MESSAGE", "CATCH_ALL", "IRYS"],
    validate: async (
        _runtime: IAgentRuntime,
        _message: Memory,
    ) => {
        console.log("Validating message:", _message.content.text);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        console.log("Starting STORE_DATA_ON_IRYS handler...");
        console.log("User message:", message.content.text);
        console.log("Message generated:", state.recentMessagesData[0].content.text);
        const irysService: IrysService = runtime.getService(ServiceType.IRYS);
        const result = await irysService.uploadDataOnIrys(state.recentMessagesData[0].content.text);
        if (state.recentMessagesData[1].content.attachments.length > 0) {
            const userAttachmentToStore = state.recentMessagesData[1].content.attachments[0].url.replace("agent\\agent", "agent");
            const resultImage = await irysService.uploadFileOrImageOnIrys(userAttachmentToStore);
            console.log("Result Image:", resultImage);
        }
        console.log("Result:", result);

        return true;
    },
    examples: [
    ] as ActionExample[][],
}
