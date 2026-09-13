/**
 * Holds family deletion admission through the canonical scheduler's complete
 * execution attempt, including final receipt writes. Uncertain completion keeps
 * the durable claim for reconciliation rather than assuming a dispatcher stopped.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  ScheduledTask,
  ScheduledTaskFireResult,
} from "@elizaos/plugin-scheduling";
import {
  beginFamilyWorkspaceOperation,
  settleFamilyWorkspaceOperation,
} from "./workspace-operation-store.js";

export async function withFamilyScheduledExecution(
  runtime: IAgentRuntime,
  task: ScheduledTask,
  execute: () => Promise<ScheduledTaskFireResult>,
): Promise<ScheduledTaskFireResult> {
  const family =
    task.metadata?.systemOperation === "family.monthlyCoordination" ||
    task.metadata?.householdGrantExpiryWarning !== undefined;
  if (!family) return execute();
  const operationId = await beginFamilyWorkspaceOperation(runtime, {
    kind: "family-scheduled-execution",
    taskId: task.taskId,
  });
  try {
    const result = await execute();
    await settleFamilyWorkspaceOperation(runtime, operationId);
    return result;
  } catch (cause) {
    // error-policy:J2 Dispatch or persistence may have committed before acknowledgement failed.
    const error = new ElizaError(
      "[FamilyWorkspace] Reconcile the scheduled execution before deletion",
      {
        code: "FAMILY_OPERATION_RECONCILIATION_REQUIRED",
        context: { operationId, taskId: task.taskId },
        cause,
      },
    );
    runtime.reportError("FamilyWorkspace.scheduledExecution", error);
    throw error;
  }
}
