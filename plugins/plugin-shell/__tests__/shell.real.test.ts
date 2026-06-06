import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
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
});
