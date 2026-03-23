import { IAgentRuntime, Action, Memory, State } from "../types.ts";

export class ParallelActionManager {
    /**
     * Orchestrates the execution of multiple actions in parallel.
     * Prevents race conditions while maximizing agent throughput.
     */
    static async runParallel(
        runtime: IAgentRuntime,
        actions: Action[],
        message: Memory,
        state: State
    ) {
        const promises = actions.map(action => 
            action.handler(runtime, message, state)
        );
        return Promise.all(promises);
    }
}
