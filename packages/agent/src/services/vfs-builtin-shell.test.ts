/**
 * `>>` redirects in the VFS builtin shell append to the existing file. Only a
 * missing target is an empty base: any other read failure must fail the
 * command and leave the file untouched rather than overwrite it.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runVfsBuiltinShell } from "./vfs-builtin-shell.ts";
import {
  createVirtualFilesystemService,
  VirtualFilesystemError,
  VirtualFilesystemService,
} from "./virtual-filesystem.ts";

const PROJECT = "shell-append";
let stateDir: string;
let savedStateDir: string | undefined;

function sh(script: string) {
  return runVfsBuiltinShell({
    cwdUri: `vfs://${PROJECT}/`,
    command: "sh",
    args: ["-c", script],
  });
}

function vfs() {
  return createVirtualFilesystemService({ projectId: PROJECT, stateDir });
}

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vfs-shell-"));
  savedStateDir = process.env.ELIZA_STATE_DIR;
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = savedStateDir;
  await fsp.rm(stateDir, { recursive: true, force: true });
});

describe("runVfsBuiltinShell >> redirect", () => {
  it("appends to an existing file and creates a missing one", async () => {
    await vfs().writeFile("log.txt", "one\n");

    const appended = await sh("echo two >> log.txt && echo new >> fresh.txt");
    expect(appended.exitCode).toBe(0);
    expect(await vfs().readFile("log.txt")).toBe("one\ntwo\n");
    expect(await vfs().readFile("fresh.txt")).toBe("new\n");
  });

  it("fails without overwriting when the existing file cannot be read", async () => {
    await vfs().writeFile("log.txt", "keep me\n");
    const readFile = VirtualFilesystemService.prototype.readFile;
    vi.spyOn(VirtualFilesystemService.prototype, "readFile").mockImplementation(
      async function (this: VirtualFilesystemService, virtualPath, encoding) {
        if (virtualPath.endsWith("log.txt")) {
          throw new VirtualFilesystemError(
            "VFS storage operation failed",
            "VFS_STORAGE_FAILED",
          );
        }
        return readFile.call(this, virtualPath, encoding);
      },
    );

    const result = await sh("echo lost >> log.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("VFS storage operation failed");
    vi.restoreAllMocks();
    expect(await vfs().readFile("log.txt")).toBe("keep me\n");
  });
});

describe("runVfsBuiltinShell redirect with a failing command", () => {
  it("truncates a stale > target and propagates the exit code", async () => {
    await vfs().writeFile("log.txt", "alpha\n");
    await vfs().writeFile("out.txt", "stale\n");

    const result = await sh("grep nomatch log.txt > out.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(await vfs().readFile("out.txt")).toBe("");
  });

  it("creates an empty > target for an unknown command", async () => {
    const result = await sh("unknowncmd > new.txt");

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(await vfs().readFile("new.txt")).toBe("");
  });

  it("leaves a >> target unchanged and propagates the exit code", async () => {
    await vfs().writeFile("log.txt", "alpha\n");
    await vfs().writeFile("log2.txt", "keep\n");

    const result = await sh("grep nomatch log.txt >> log2.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(await vfs().readFile("log2.txt")).toBe("keep\n");
  });
});

describe("runVfsBuiltinShell quoted redirection", () => {
  it.each([
    ["echo 'alpha>beta'", "alpha>beta\n"],
    ['echo "alpha>beta"', "alpha>beta\n"],
    ["echo 'alpha>>beta'", "alpha>>beta\n"],
    ['echo "alpha>>beta"', "alpha>>beta\n"],
    ["echo 'alpha\" > beta'", 'alpha" > beta\n'],
    ['echo "alpha\' > beta"', "alpha' > beta\n"],
  ])(
    "preserves literal output for %s without creating files",
    async (script, stdout) => {
      const result = await sh(script);

      expect(result).toMatchObject({ exitCode: 0, stdout, stderr: "" });
      expect(await vfs().list("/")).toEqual([]);
    },
  );

  it("overwrites and appends quoted output through an unquoted redirect", async () => {
    await vfs().writeFile("log.txt", "replace me\n");

    const result = await sh(
      "echo 'alpha>beta' > log.txt && echo \"gamma>>delta\" >> log.txt && cat log.txt",
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "alpha>beta\ngamma>>delta\n",
      stderr: "",
    });
    expect(await vfs().readFile("log.txt")).toBe("alpha>beta\ngamma>>delta\n");
  });
});

describe("runVfsBuiltinShell separators", () => {
  it.each([
    ["cat missing.txt; echo after", "after\n", 0],
    ["cat missing.txt && echo skipped; echo after", "after\n", 0],
    ["cat missing.txt && echo a && echo b", "", 1],
    ["echo ok; cat missing.txt", "ok\n", 1],
  ])("runs %s with POSIX separator semantics", async (script, stdout, exit) => {
    const result = await sh(script);

    expect(result.stdout).toBe(stdout);
    expect(result.exitCode !== 0).toBe(exit !== 0);
  });

  it("reports a thrown segment error and continues after `;`", async () => {
    await vfs().writeFile("log.txt", "keep me\n");
    const readFile = VirtualFilesystemService.prototype.readFile;
    vi.spyOn(VirtualFilesystemService.prototype, "readFile").mockImplementation(
      async function (this: VirtualFilesystemService, virtualPath, encoding) {
        if (virtualPath.endsWith("log.txt")) {
          throw new VirtualFilesystemError(
            "VFS storage operation failed",
            "VFS_STORAGE_FAILED",
          );
        }
        return readFile.call(this, virtualPath, encoding);
      },
    );

    const result = await sh("echo lost >> log.txt; echo after");
    expect(result).toMatchObject({ exitCode: 0, stdout: "after\n" });
    expect(result.stderr).toContain("VFS storage operation failed");
    vi.restoreAllMocks();
    expect(await vfs().readFile("log.txt")).toBe("keep me\n");
  });
});

describe("runVfsBuiltinShell quoted redirect targets", () => {
  it.each([
    ['report".txt"', "report.txt"],
    ['"two "words.txt', "two words.txt"],
    ["two\\ words.txt", "two words.txt"],
    ["'\"quoted.txt\"'", '"quoted.txt"'],
  ])(
    "uses shell word parsing for redirect target %s",
    async (target, filename) => {
      const result = await sh(`echo hello > ${target} && cat ${target}`);
      expect(await vfs().readFile(filename)).toBe("hello\n");
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
      });
    },
  );

  it("writes to a single-quoted target containing a space", async () => {
    const result = await sh(
      "echo hello > 'two words.txt' && cat 'two words.txt'",
    );

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "hello\n",
      stderr: "",
    });
    expect(await vfs().readFile("two words.txt")).toBe("hello\n");
  });

  it("overwrites and appends to a double-quoted target containing a space", async () => {
    const result = await sh(
      'echo a > "x y.txt" && echo b >> "x y.txt" && cat "x y.txt"',
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: "a\nb\n", stderr: "" });
    expect(await vfs().readFile("x y.txt")).toBe("a\nb\n");
  });

  it("still treats a fully quoted argument as literal output", async () => {
    const result = await sh("echo 'a > b'");

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "a > b\n",
      stderr: "",
    });
    expect(await vfs().list("/")).toEqual([]);
  });
});

describe("runVfsBuiltinShell word splitting", () => {
  it("joins adjacent quoted and unquoted fragments into one path", async () => {
    await vfs().writeFile("report.txt", "contents\n");

    const result = await sh('cat report".txt"');

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "contents\n",
      stderr: "",
    });
  });

  it.each([
    ["echo 'a b'\"c\"", "a bc\n"],
    ["echo a\\ b", "a b\n"],
    ["echo foo\\.bar", "foo.bar\n"],
    ['echo "\\d+"', "\\d+\n"],
    ["echo '\\d+'", "\\d+\n"],
    ['echo "say \\"hi\\""', 'say "hi"\n'],
  ])("splits %s like POSIX sh", async (script, stdout) => {
    const result = await sh(script);

    expect(result).toMatchObject({ exitCode: 0, stdout, stderr: "" });
  });

  it("keeps the backslash in a double-quoted grep pattern", async () => {
    await vfs().writeFile("f.txt", "id 42\nnone\n");

    const result = await sh('grep "\\d+" f.txt');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("id 42");
    expect(result.stdout).not.toContain("none");
  });

  it("fails on an unterminated quote instead of dropping it", async () => {
    const result = await sh('echo "abc');

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unterminated");
  });
});

describe("runVfsBuiltinShell grep/rg on empty files", () => {
  function search(command: "grep" | "rg", args: readonly string[]) {
    return runVfsBuiltinShell({
      cwdUri: `vfs://${PROJECT}/`,
      command,
      args: [...args],
    });
  }

  it.each([
    ["grep", ["-n", "^$", "empty.txt"]],
    ["grep", ["-v", "foo", "empty.txt"]],
    ["rg", ["^$", "empty.txt"]],
    ["rg", ["-v", "foo", "empty.txt"]],
  ] as const)(
    "%s %j selects no lines in a zero-byte file",
    async (command, args) => {
      await vfs().writeFile("empty.txt", "");

      const result = await search(command, args);

      expect(result).toMatchObject({ exitCode: 1, stdout: "", stderr: "" });
    },
  );

  it.each([
    ["grep", ["-n", "^$", "blank.txt"]],
    ["rg", ["^$", "blank.txt"]],
  ] as const)(
    "%s %j matches the one blank line of a newline-only file",
    async (command, args) => {
      await vfs().writeFile("blank.txt", "\n");

      const result = await search(command, args);

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "blank.txt:1:\n",
        stderr: "",
      });
    },
  );
});
