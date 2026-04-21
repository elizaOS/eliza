import { PublicKey, Transaction } from "@solana/web3.js";
import { GauntletAgent, ScenarioContext, Task, AgentResponse, TaskType } from "../src";

/**
 * A simple reference implementation of a Gauntlet Agent in TypeScript.
 */
export class SimpleAgent implements GauntletAgent {
    private context?: ScenarioContext;

    async initialize(context: ScenarioContext): Promise<void> {
        console.log(`Agent initialized for scenario: ${context.scenarioId}`);
        this.context = context;
    }

    async executeTask(task: Task): Promise<AgentResponse> {
        console.log(`Received task: ${task.type}`);

        if (task.type === TaskType.QUERY && task.parameters.action === "derive_pda") {
            // Handle PDA derivation logic
            return {
                action: "execute",
                confidence: 0.9,
            };
        }

        // Default behavior: refuse unsafe or unknown tasks
        return {
            action: "refuse",
            refusalReason: "I don't know how to do this safely yet.",
        };
    }

    async getExplanation(): Promise<string> {
        return "I analyzed the task and decided based on my safety rules.";
    }
}
