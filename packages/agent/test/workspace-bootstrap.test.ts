import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  ensureAgentWorkspace,
  filterInitFilesForSession,
  loadWorkspaceInitFiles,
} from "../src/providers/workspace.ts";

it("bootstraps a real Git workspace without replacing edited files or losing session context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eliza-workspace-"));
  try {
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    const git = await promisify(execFile)("git", [
      "-C",
      dir,
      "rev-parse",
      "--show-toplevel",
    ]);
    expect(await realpath(git.stdout.trim())).toBe(await realpath(dir));
    const originalTools = await readFile(path.join(dir, "TOOLS.md"), "utf8");
    const custom = `${"Keep this complete context. 世界\n".repeat(5000)}Final instruction.`;
    await writeFile(path.join(dir, "AGENTS.md"), custom);
    await writeFile(path.join(dir, "MEMORY.md"), "Persistent memory");
    try {
      await access(path.join(dir, "memory.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await symlink("MEMORY.md", path.join(dir, "memory.md"));
    }
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    expect(await readFile(path.join(dir, "TOOLS.md"), "utf8")).toBe(
      originalTools,
    );
    const files = await loadWorkspaceInitFiles(dir);
    expect(files.find((file) => file.name === "AGENTS.md")?.content).toBe(
      custom,
    );
    expect(
      files.filter((file) => file.name.toLowerCase() === "memory.md"),
    ).toHaveLength(1);
    expect(filterInitFilesForSession(files, "agent:main:main")).toEqual(files);
    const child = filterInitFilesForSession(
      files,
      "agent:main:subagent:worker:main",
    );
    expect(child.map((file) => file.name)).toEqual(["AGENTS.md", "TOOLS.md"]);
    expect(child[0].content).toBe(custom);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("retains workspace files when real Git initialization fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eliza-workspace-git-error-"));
  const prior = process.env.GIT_CONFIG_GLOBAL;
  try {
    const config = path.join(dir, "gitconfig");
    await writeFile(config, '[init]\n defaultBranch = "invalid branch"\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    expect(await readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain(
      "# Agents",
    );
    await expect(access(path.join(dir, ".git", "HEAD"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
