/**
 * Unit tests for sandbox-stub: validates fallback actions for sandbox and unsupported terminal runtimes.
 */
import { describe, expect, it } from "vitest";
import {
  createTerminalUnsupportedTasksAction,
  tasksSandboxStubAction,
} from "./sandbox-stub.ts";

describe("sandbox-stub", () => {
  it("exports tasksSandboxStubAction with TASKS name and suppression flag", () => {
    expect(tasksSandboxStubAction.name).toBe("TASKS");
    expect(tasksSandboxStubAction.suppressPostActionContinuation).toBe(true);
  });

  it("creates terminal unsupported tasks action with typed reason", () => {
    const action = createTerminalUnsupportedTasksAction({
      supported: false,
      reason: "vanilla_mobile",
      message: "Mobile is unsupported",
    });
    expect(action.name).toBe("TASKS");
    expect(action.suppressPostActionContinuation).toBe(true);
  });
});
