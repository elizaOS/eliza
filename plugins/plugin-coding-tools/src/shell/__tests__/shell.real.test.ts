/**
 * End-to-end tests for ShellService and shellHistoryProvider driving a real
 * spawned shell in a temp directory (no mocks) — command execution, session
 * tracking, and history-provider context injection.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellHistoryProvider } from "../providers/shellHistoryProvider";
import { resetProcessRegistryForTests } from "../services/processRegistry";
import { ShellService } from "../services/shellService";

function createRuntime(service: ShellService | null): IAgentRuntime {
  return {
    character: {},
    getService(name: string) {
      return name === "shell" ? service : null;
    },
  } as IAgentRuntime;
}

// The real-integration tests below run actual shell commands like
// `printf "..." > file`. On Windows the default shell is PowerShell, which
// (a) doesn't ship `printf` and (b) writes UTF-16LE BOMs into redirected
// files — neither shape matches the asserted UTF-8 string. The shell
// service itself is cross-platform (it spawns via cross-spawn / node-pty);
// the assertions are POSIX-shell-shaped. Skip on Windows; the unit tests
// in `__tests__/shell.test.ts` cover the same code paths without
// depending on shell-output formatting.
const describePosixShell = process.platform === "win32" ? describe.skip : describe;

describePosixShell("shell plugin real local integration", () => {
  let allowedDirectory = "";
  let previousAllowedDirectory: string | undefined;
  let service: ShellService;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    allowedDirectory = mkdtempSync(path.join(tmpdir(), "eliza-shell-live-"));
    previousAllowedDirectory = process.env.SHELL_ALLOWED_DIRECTORY;
    process.env.SHELL_ALLOWED_DIRECTORY = allowedDirectory;

    service = await ShellService.start(createRuntime(null));
    runtime = createRuntime(service);
  });

  afterEach(async () => {
    await service.stop();
    resetProcessRegistryForTests();

    if (previousAllowedDirectory === undefined) {
      delete process.env.SHELL_ALLOWED_DIRECTORY;
    } else {
      process.env.SHELL_ALLOWED_DIRECTORY = previousAllowedDirectory;
    }

    rmSync(allowedDirectory, { recursive: true, force: true });
  });

  it("executes a real command in the allowed directory and exposes it through the provider", async () => {
    const result = await service.executeCommand('printf "live-shell" > output.txt', "room-1");
    expect(result.success).toBe(true);
    expect(readFileSync(path.join(allowedDirectory, "output.txt"), "utf8")).toBe("live-shell");

    const provider = await shellHistoryProvider.get(
      runtime,
      { roomId: "room-1", agentId: "agent-1" } as never,
      {} as never
    );

    expect(provider.text).toContain("output.txt");
    expect(provider.text).toContain(allowedDirectory);
    expect(provider.values?.currentWorkingDirectory).toBe(allowedDirectory);
  });

  it("fails closed when a command tries to escape the allowed directory", async () => {
    const result = await service.executeCommand("cd ../..", "room-1");

    expect(result.success).toBe(false);
    expect(result.stderr).toMatch(
      /Cannot navigate outside allowed directory|Command contains forbidden patterns/
    );
    expect(service.getCurrentDirectory()).toBe(allowedDirectory);
  });

  it("surfaces a model-visible error instead of blank output when history retrieval throws", async () => {
    // Regression for the swallowed-catch fallback slop (#12273/#12799): a real
    // ShellService whose history read throws must NOT be reported to the model
    // as empty, success-shaped context. The failure has to reach the model loop
    // (non-empty status text + values) and the developer logs (logger.error).
    const boom = new Error("history backend exploded");
    const reported: Array<{ scope: string; error: unknown }> = [];
    const throwingService = {
      getCommandHistory() {
        throw boom;
      },
      getCurrentDirectory: () => allowedDirectory,
      getAllowedDirectory: () => allowedDirectory,
    } as unknown as ShellService;
    // Runtime double that exposes the #12263 diagnostic boundary so we can
    // assert the provider routes failures through it (RECENT_ERRORS visibility)
    // rather than swallowing them.
    const throwingRuntime = {
      character: {},
      getService(name: string) {
        return name === "shell" ? throwingService : null;
      },
      reportError(scope: string, error: unknown) {
        reported.push({ scope, error });
      },
    } as unknown as IAgentRuntime;

    const provider = await shellHistoryProvider.get(
      throwingRuntime,
      { roomId: "room-boom", agentId: "agent-1" } as never,
      {} as never
    );

    // Model-visible: not blank, and it names the failure.
    expect(provider.text).not.toBe("");
    expect(provider.text).toContain("unavailable");
    expect(provider.text).toContain("history backend exploded");
    expect(provider.values?.shellHistory).toContain("history backend exploded");
    expect(provider.data?.error).toBe("history backend exploded");

    // Diagnostic boundary: the failure was routed through runtime.reportError
    // (which emits ERROR_REPORTED + feeds the RECENT_ERRORS provider) instead
    // of being silently swallowed.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.scope).toBe("shellHistoryProvider");
    expect(reported[0]?.error).toBe(boom);
  });

  it("still logs the failure when the runtime lacks reportError (older runtimes/test doubles)", async () => {
    const boom = new Error("legacy history failure");
    const throwingService = {
      getCommandHistory() {
        throw boom;
      },
      getCurrentDirectory: () => allowedDirectory,
      getAllowedDirectory: () => allowedDirectory,
    } as unknown as ShellService;
    // createRuntime() intentionally has no reportError -> exercises the fallback.
    const legacyRuntime = createRuntime(throwingService);

    const errorLogs: unknown[] = [];
    const originalError = logger.error;
    (logger as unknown as { error: (...a: unknown[]) => void }).error = (...args: unknown[]) => {
      errorLogs.push(args);
    };

    try {
      const provider = await shellHistoryProvider.get(
        legacyRuntime,
        { roomId: "room-legacy", agentId: "agent-1" } as never,
        {} as never
      );
      expect(provider.text).toContain("legacy history failure");
      expect(provider.data?.error).toBe("legacy history failure");
    } finally {
      (logger as unknown as { error: typeof originalError }).error = originalError;
    }

    expect(errorLogs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(errorLogs);
    expect(serialized).toContain("shellHistoryProvider");
    expect(serialized).toContain("legacy history failure");
  });
});
