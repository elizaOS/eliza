/** Verifies that plugin services cross the Code example boundary only when their contract is complete. */
import { describe, expect, it } from "bun:test";
import type { AgentRuntime, Service } from "@elizaos/core";
import type { CodeTaskService } from "../types.js";
import { getCodeTaskService } from "./get-code-task-service.js";

const methods = [
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
] as const;

function runtimeReturning(
  service: Service | null,
): Pick<AgentRuntime, "getService"> {
  return { getService: <T extends Service>() => service as T | null };
}

describe("getCodeTaskService", () => {
  it("rejects missing and incomplete services", () => {
    expect(getCodeTaskService(runtimeReturning(null))).toBeNull();
    expect(getCodeTaskService(runtimeReturning({} as Service))).toBeNull();
  });

  it("returns a service implementing every required operation", () => {
    const service = Object.fromEntries(
      methods.map((method) => [method, () => undefined]),
    ) as unknown as Service & CodeTaskService;
    expect(getCodeTaskService(runtimeReturning(service))).toBe(service);
  });
});
