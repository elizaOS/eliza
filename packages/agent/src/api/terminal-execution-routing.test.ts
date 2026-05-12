import { afterEach, describe, expect, it } from "vitest";
import { resolveTerminalExecutionRoute } from "./terminal-execution-routing.ts";

describe("terminal execution routing", () => {
  const previousMode = process.env.ELIZA_RUNTIME_MODE;

  afterEach(() => {
    if (previousMode === undefined) {
      delete process.env.ELIZA_RUNTIME_MODE;
    } else {
      process.env.ELIZA_RUNTIME_MODE = previousMode;
    }
  });

  it("defaults terminal execution to host/yolo routing", () => {
    delete process.env.ELIZA_RUNTIME_MODE;
    const route = resolveTerminalExecutionRoute({
      runtime: null,
      sandboxManager: {
        exec: async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          durationMs: 0,
          executedInSandbox: true,
        }),
      } as never,
    });
    expect(route.route).toBe("host");
    expect(route.sandboxManager).toBeNull();
  });

  it("requires SandboxManager for local-safe terminal execution", () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const route = resolveTerminalExecutionRoute({
      runtime: null,
      sandboxManager: null,
    });
    expect(route.route).toBe("sandbox");
    expect(route.error).toContain("requires SandboxManager");
  });

  it("routes local-safe terminal execution to SandboxManager when available", () => {
    process.env.ELIZA_RUNTIME_MODE = "local-safe";
    const sandboxManager = {
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
        executedInSandbox: true,
      }),
    } as never;
    const route = resolveTerminalExecutionRoute({
      runtime: null,
      sandboxManager,
    });
    expect(route.route).toBe("sandbox");
    expect(route.sandboxManager).toBe(sandboxManager);
    expect(route.error).toBeUndefined();
  });
});
