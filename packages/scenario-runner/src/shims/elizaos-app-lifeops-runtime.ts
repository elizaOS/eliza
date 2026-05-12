/**
 * Type-only shim for `@elizaos/app-lifeops/lifeops/runtime`.
 * Executor loads the real module at runtime via dynamic `import()`; this file
 * satisfies TypeScript without compiling the full app-lifeops graph (TS6059).
 */
import type { IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsReminderAttempt,
  LifeOpsWorkflowRun,
} from "@elizaos/shared";

export declare function executeLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): Promise<{
  nextInterval: number;
  now: string;
  reminderAttempts: LifeOpsReminderAttempt[];
  workflowRuns: LifeOpsWorkflowRun[];
}>;
