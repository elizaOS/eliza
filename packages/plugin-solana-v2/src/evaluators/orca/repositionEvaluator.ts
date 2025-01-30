import {
    elizaLogger,
    Evaluator,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";
import { sendMessage } from "../../utils/sendMessage";
import { extractAndValidateConfiguration } from "../../actions/orca/managePositions";

export const managePositionActionRetriggerEvaluator: Evaluator = {
    name: "MANAGE_POSITIONS_RETRIGGER_EVALUATOR",
    similes: ["MANAGE_POSITIONS_RETRIGGER"],
    alwaysRun: true,
    description: "Schedules and monitors ongoing repositioning actions to ensure continuous operation.",
    validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        elizaLogger.log("Che");
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }
        const config = await extractAndValidateConfiguration(message.content.text, runtime);
        if (!config || typeof config.intervalSeconds !== "number" || config.intervalSeconds <= 0) {
            elizaLogger.debug(
                "Configuration is invalid, null, or does not have a valid positive value for intervalSeconds. Exiting evaluator."
            );
            return;
        }
        const instervalMs = config.intervalSeconds * 1000;
        elizaLogger.log(`Using time threshold: ${instervalMs} miliseconds`);
        await new Promise((resolve) => setTimeout(resolve, instervalMs));
        sendMessage({
            agentId: runtime.agentId,
            text: message.content.text, // Reuse the original message text
        });
    },
    examples: [],
};