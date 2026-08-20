/**
 * End-to-end tests for ShellService and shellHistoryProvider driving a real
 * spawned shell in a temp directory (no mocks) — command execution, session
 * tracking, and history-provider context injection.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellHistoryProvider } from "../providers/shellHistoryProvider";
import { resetProcessRegistryForTests } from "../services/processRegistry";
import { ShellService } from "../services/shellService";

function createRuntime(
  service: ShellService | null,
  configuredSecret?: string,
): IAgentRuntime {
  return {
    character: {},
    getService(name: string) {
      return name === "shell" ? service : null;
    },
    redactSecrets(text: string) {
      return configuredSecret
        ? text.replaceAll(configuredSecret, "[REDACTED:TEST_SECRET]")
        : text;
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
const describePosixShell =
  process.platform === "win32" ? describe.skip : describe;

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
    const result = await service.executeCommand(
      'printf "live-shell" > output.txt',
      "room-1",
    );
    expect(result.success).toBe(true);
    expect(
      readFileSync(path.join(allowedDirectory, "output.txt"), "utf8"),
    ).toBe("live-shell");

    const provider = await shellHistoryProvider.get(
      runtime,
      { roomId: "room-1", agentId: "agent-1" } as never,
      {} as never,
    );

    expect(provider.text).toContain("output.txt");
    expect(provider.text).toContain(allowedDirectory);
    expect(provider.values?.currentWorkingDirectory).toBe(allowedDirectory);
  });

  it("captures deliberately split multibyte stdout and stderr without corruption", async () => {
    const script = [
      'const value = Buffer.from("\u4f60");',
      "process.stdout.write(value.subarray(0, 1));",
      "process.stderr.write(value.subarray(0, 2));",
      "setTimeout(() => {",
      "  process.stdout.write(value.subarray(1));",
      "  process.stderr.write(value.subarray(2));",
      "}, 50);",
    ].join("");
    const result = await service.executeCommand(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      "room-utf8",
    );

    expect(result.success).toBe(true);
    expect(result.stdout).toBe("\u4f60");
    expect(result.stderr).toBe("\u4f60");
  });

  it("stores and provides only redacted configured bare secrets", async () => {
    const secret = "marigold9";
    await service.stop();
    service = await ShellService.start(createRuntime(null, secret));
    runtime = createRuntime(service, secret);
    const result = await service.executeCommand(
      `printf '%s\\n' '${secret}'`,
      "room-secret",
    );
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);

    const history = service.getCommandHistory("room-secret", 10);
    const provider = await shellHistoryProvider.get(
      runtime,
      { roomId: "room-secret", agentId: "agent-1" } as never,
      {} as never,
    );

    expect(JSON.stringify(history)).not.toContain(secret);
    expect(JSON.stringify(provider)).not.toContain(secret);
  });

  it("fails closed when a command tries to escape the allowed directory", async () => {
    const result = await service.executeCommand("cd ../..", "room-1");

    expect(result.success).toBe(false);
    expect(result.stderr).toMatch(
      /Cannot navigate outside allowed directory|Command contains forbidden patterns/,
    );
    expect(service.getCurrentDirectory()).toBe(allowedDirectory);
  });

  it("rejects a real shell workdir symlink that resolves outside", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "eliza-shell-outside-"));
    try {
      symlinkSync(outside, path.join(allowedDirectory, "escape"));
      const result = await service.exec("pwd", {
        workdir: path.join(allowedDirectory, "escape"),
      });

      expect(result.status).toBe("failed");
      expect(result.reason).toContain(
        "unavailable or outside allowed directory",
      );
      expect(service.getCurrentDirectory()).toBe(allowedDirectory);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves an existing relative workdir from the service cwd", async () => {
    const inside = path.join(allowedDirectory, "inside");
    mkdirSync(inside);

    const result = await service.exec("pwd", { workdir: "inside" });

    expect(result.status).toBe("completed");
    expect(result.cwd).toBe(realpathSync(inside));
  });

  it("rejects a missing explicit workdir under the default allowed root", async () => {
    await service.stop();
    process.env.SHELL_ALLOWED_DIRECTORY = process.cwd();
    service = await ShellService.start(createRuntime(null));

    const missing = path.join(
      process.cwd(),
      `.eliza-shell-missing-${process.pid}-${Date.now()}`,
    );
    const result = await service.exec("pwd", { workdir: missing });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("unavailable or outside allowed directory");
  });

  it("surfaces a model-visible error instead of blank output when history retrieval throws", async () => {
    // Regression for the swallowed-catch fallback slop (#12273/#12799): a real
    // ShellService whose history read throws must NOT be reported to the model
    // as empty, success-shaped context. The failure has to reach the model loop
    // (non-empty status text + values) and the developer logs (logger.error).
    const secret = "orchid42";
    const boom = new Error(`history ${secret} exploded`);
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
      redactSecrets(text: string) {
        return text.replaceAll(secret, "[REDACTED:TEST_SECRET]");
      },
      reportError(scope: string, error: unknown) {
        reported.push({ scope, error });
      },
    } as unknown as IAgentRuntime;

    const provider = await shellHistoryProvider.get(
      throwingRuntime,
      { roomId: "room-boom", agentId: "agent-1" } as never,
      {} as never,
    );

    // Model-visible: not blank, and it names the failure.
    expect(provider.text).not.toBe("");
    expect(provider.text).toContain("unavailable");
    expect(provider.text).toContain("history [REDACTED:TEST_SECRET] exploded");
    expect(provider.values?.shellHistory).toContain(
      "history [REDACTED:TEST_SECRET] exploded",
    );
    expect(provider.data?.error).toBe(
      "history [REDACTED:TEST_SECRET] exploded",
    );

    // Diagnostic boundary: the failure was routed through runtime.reportError
    // (which emits ERROR_REPORTED + feeds the RECENT_ERRORS provider) instead
    // of being silently swallowed.
    expect(reported).toHaveLength(1);
    expect(reported[0]?.scope).toBe("shellHistoryProvider");
    expect(reported[0]?.error).toMatchObject({
      name: "ElizaError",
      code: "SHELL_HISTORY_PROVIDER_FAILED",
      context: {
        redactedMessage: "history [REDACTED:TEST_SECRET] exploded",
      },
    });
    expect(JSON.stringify({ provider, reported })).not.toContain(secret);
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
    (logger as unknown as { error: (...a: unknown[]) => void }).error = (
      ...args: unknown[]
    ) => {
      errorLogs.push(args);
    };

    try {
      const provider = await shellHistoryProvider.get(
        legacyRuntime,
        { roomId: "room-legacy", agentId: "agent-1" } as never,
        {} as never,
      );
      expect(provider.text).toContain("legacy history failure");
      expect(provider.data?.error).toBe("legacy history failure");
    } finally {
      (logger as unknown as { error: typeof originalError }).error =
        originalError;
    }

    expect(errorLogs.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(errorLogs);
    expect(serialized).toContain("shellHistoryProvider");
    expect(serialized).toContain("legacy history failure");
  });
});
