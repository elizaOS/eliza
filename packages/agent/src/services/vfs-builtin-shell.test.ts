import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVfsBuiltinShell } from "./vfs-builtin-shell.ts";
import { createVirtualFilesystemService } from "./virtual-filesystem.ts";

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

  it("runs grep and rg over VFS files without host ripgrep", async () => {
    const vfs = createVirtualFilesystemService({ projectId: "searchable" });
    await vfs.initialize();
    await vfs.writeFile("src/a.ts", "alpha\nneedle one\n");
    await vfs.writeFile("src/nested/b.ts", "Needle two\n");
    await vfs.writeFile("README.md", "outside\n");

    const rg = await runVfsBuiltinShell({
      cwdUri: "vfs://searchable/src",
      command: "rg",
      args: ["-i", "needle"],
    });
    expect(rg).toMatchObject({ exitCode: 0 });
    expect(rg.stdout).toContain("src/a.ts:2:needle one");
    expect(rg.stdout).toContain("src/nested/b.ts:1:Needle two");
    expect(rg.stdout).not.toContain("README.md");

    const files = await runVfsBuiltinShell({
      cwdUri: "vfs://searchable/src",
      command: "rg",
      args: ["--files"],
    });
    expect(files.stdout).toContain("src/a.ts");
    expect(files.stdout).toContain("src/nested/b.ts");
  });
});
