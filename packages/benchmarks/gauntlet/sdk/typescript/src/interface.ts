import { AgentResponse, ScenarioContext, Task } from "./types";

/**
 * Interface that all agents must implement to handle Gauntlet tasks.
 */
export interface GauntletAgent {
    /**
     * Initialize the agent with scenario context.
     * Called once at the beginning of a scenario.
     */
    initialize(context: ScenarioContext): Promise<void>;

    /**
     * Execute a specific task.
     * Expected to return an AgentResponse indicating action (execute/refuse)
     * and providing the signed transaction if executing.
     */
    executeTask(task: Task): Promise<AgentResponse>;

    /**
     * Providing an explanation for the previous action.
     * Used for scoring reasoning capabilities.
     */
    getExplanation(): Promise<string>;
}
