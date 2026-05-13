import type { AgentRuntime, Service } from "@elizaos/core";
import type { CodeTaskService } from "../types.js";

const CODE_TASK_SERVICE_ID = "CODE_TASK" as const;

function fnAt(obj: Service, key: keyof CodeTaskService): boolean {
  if (!(key in obj)) return false;
  const candidate = Reflect.get(obj, key as PropertyKey);
  return typeof candidate === "function";
}

/**
 * Structural check so we do not assert plugin services to {@link CodeTaskService} blindly.
 */
function isCodeTaskService(
  service: Service,
): service is Service & CodeTaskService {
  const keys = [
    "createCodeTask",
    "createTask",
    "getCurrentTask",
    "getTask",
    "getTasks",
    "startTaskExecution",
    "pauseTask",
    "resumeTask",
    "cancelTask",
    "deleteTask",
    "renameTask",
    "appendOutput",
    "setCurrentTask",
    "getCurrentTaskId",
    "setUserStatus",
    "setTaskSubAgentType",
    "detectAndPauseInterruptedTasks",
    "on",
  ] as const satisfies readonly (keyof CodeTaskService)[];

  for (const k of keys) {
    if (!fnAt(service, k)) return false;
  }
  return true;
}

export function getCodeTaskService(
  runtime: AgentRuntime,
): CodeTaskService | null {
  const service = runtime.getService<Service>(CODE_TASK_SERVICE_ID);
  if (!service || !isCodeTaskService(service)) return null;
  return service;
}
