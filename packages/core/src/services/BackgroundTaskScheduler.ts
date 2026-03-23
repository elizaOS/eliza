import { IAgentRuntime, Action, Memory } from "../types.ts";

export class BackgroundTaskScheduler {
    /**
     * Schedules and manages asynchronous background tasks.
     * Essential for long-running autonomous operations.
     */
    static async schedule(
        runtime: IAgentRuntime,
        taskName: string,
        handler: () => Promise<void>,
        intervalMs: number
    ) {
        console.log(`Scheduling background task: ${taskName} every ${intervalMs}ms`);
        setInterval(async () => {
            try {
                await handler();
            } catch (e) {
                console.error(`Error in background task ${taskName}:`, e);
            }
        }, intervalMs);
    }
}
