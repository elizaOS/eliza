import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";
import { runVfsBuiltinShell } from "./vfs-builtin-shell.ts";

let tmpDir: string;
let oldStateDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-vfs-shell-"));
  oldStateDir = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = tmpDir;
});

afterEach(async () => {
  if (oldStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = oldStateDir;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("runVfsBuiltinShell", () => {
  it("runs a constrained shell command over vfs:// cwd", async () => {
    const vfs = createVirtualFilesystemService({ projectId: "portable" });
    await vfs.initialize();
    await vfs.writeFile("src/view.tsx", "export const View = () => null;");

    const pwd = await runVfsBuiltinShell({
      cwdUri: "vfs://portable/src",
      command: "pwd",
    });
    expect(pwd).toMatchObject({ exitCode: 0, stdout: "/src\n" });

    const cat = await runVfsBuiltinShell({
      cwdUri: "vfs://portable/src",
      command: "cat",
      args: ["view.tsx"],
    });
    expect(cat.stdout).toContain("View");

    const echo = await runVfsBuiltinShell({
      cwdUri: "vfs://portable/src",
      command: "/bin/sh",
      args: ["-c", "echo hello > generated.txt"],
    });
    expect(echo.exitCode).toBe(0);
    await expect(vfs.readFile("src/generated.txt")).resolves.toBe("hello\n");
  });
});
