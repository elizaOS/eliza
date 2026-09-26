import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecFileCommandRunner,
  LinuxInventoryCommandError,
} from "./linux-inventory";

const runner = new ExecFileCommandRunner();
describe("Linux inventory command failures", () => {
  it("preserves probe exit codes and diagnostics", async () => {
    const result = await runner.run(process.execPath, [
      "-e",
      'process.stdout.write("probe output"); process.stderr.write("probe error"); process.exit(8)',
    ]);
    expect(result).toEqual({
      stdout: "probe output",
      stderr: "probe error",
      exitCode: 8,
    });
  });
  it("distinguishes a missing tool from a permission failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inventory-command-"));
    try {
      const tool = join(directory, "tool");
      expect((await runner.run(tool, [])).exitCode).toBe(127);
      await writeFile(tool, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
      await expect(runner.run(tool, [])).rejects.toMatchObject({
        code: "ELIZAOS_LINUX_INVENTORY_COMMAND_ERROR",
        cause: { code: "EACCES" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("retains a killed probe's signal instead of reporting a missing tool", async () => {
    await expect(
      runner.run(process.execPath, [
        "-e",
        'process.kill(process.pid, "SIGTERM")',
      ]),
    ).rejects.toMatchObject({
      code: "ELIZAOS_LINUX_INVENTORY_COMMAND_ERROR",
      cause: { signal: "SIGTERM" },
    });
  });
  it("rejects truncated probe output explicitly", async () => {
    const operation = runner.run(process.execPath, [
      "-e",
      'process.stdout.write("x".repeat(5 * 1024 * 1024))',
    ]);
    await expect(operation).rejects.toBeInstanceOf(LinuxInventoryCommandError);
    await expect(operation).rejects.toMatchObject({
      cause: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    });
  });
});
