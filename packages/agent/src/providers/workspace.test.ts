/**
 * Unit coverage for the agent workspace filesystem helpers: timed command
 * execution, boilerplate detection (current and legacy templates, including
 * whitespace/CRLF/case normalization), init-file seeding that never clobbers
 * user edits, MEMORY.md / memory.md realpath dedup, missing-file markers, and
 * the subagent init-file allowlist. The module under test is real; temp
 * directories and subprocesses are the fixtures.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUserPath } from "../config/paths.ts";
import * as workspaceResolution from "../shared/workspace-resolution.ts";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
  filterInitFilesForSession,
  isDefaultBoilerplate,
  loadWorkspaceInitFiles,
  resolveDefaultAgentWorkspaceDir,
  runCommandWithTimeout,
  shouldBootstrapWorkspaceInitFiles,
  shouldUseRuntimeCwdWorkspace,
  type WorkspaceInitFile,
} from "./workspace.ts";

const LEGACY_AGENTS_TEMPLATE = `# Agents

Autonomous agent powered by elizaOS.

## Capabilities

- Respond to user messages conversationally
- Execute actions and use available tools
- Access and manage knowledge from your workspace
- Maintain context across conversations

## Guidelines

- Be helpful, concise, and accurate
- Ask for clarification when instructions are ambiguous
- Use tools when they would help accomplish the user's goal
- Respect the user's preferences and communication style
`;

const LEGACY_TOOLS_TEMPLATE = `# Tools

Available tools and capabilities for the agent.

## Built-in Tools

The agent has access to tools provided by enabled plugins.
Each plugin may register actions, providers, and evaluators
that extend the agent's capabilities.

## Usage

Tools are invoked automatically when the agent determines
they would help accomplish the user's goal. No manual
configuration is required.
`;

const INIT_NAMES = [
  "AGENTS.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "INIT.md",
] as const;

let tmpDirs: string[] = [];

async function makeTmp(prefix = "eliza-ws-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function initFile(
  name: WorkspaceInitFile["name"],
  missing = false,
): WorkspaceInitFile {
  if (missing) {
    return { name, path: `/workspace/${name}`, missing: true };
  }
  return {
    name,
    path: `/workspace/${name}`,
    content: `content of ${name}`,
    missing: false,
  };
}

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("workspace re-exports", () => {
  it("re-exports the workspace-resolution helpers by identity", () => {
    expect(DEFAULT_AGENT_WORKSPACE_DIR).toBe(
      workspaceResolution.DEFAULT_AGENT_WORKSPACE_DIR,
    );
    expect(resolveDefaultAgentWorkspaceDir).toBe(
      workspaceResolution.resolveDefaultAgentWorkspaceDir,
    );
    expect(shouldBootstrapWorkspaceInitFiles).toBe(
      workspaceResolution.shouldBootstrapWorkspaceInitFiles,
    );
    expect(shouldUseRuntimeCwdWorkspace).toBe(
      workspaceResolution.shouldUseRuntimeCwdWorkspace,
    );
  });

  it("treats a directory with package.json as a project workspace", async () => {
    const dir = await makeTmp("eliza-ws-marker-");
    await fs.writeFile(path.join(dir, "package.json"), "{}\n");
    expect(shouldUseRuntimeCwdWorkspace(dir)).toBe(true);
    expect(shouldBootstrapWorkspaceInitFiles(dir)).toBe(false);
  });

  it("bootstraps init files when the directory has no project markers", async () => {
    const dir = await makeTmp("eliza-ws-empty-");
    expect(shouldUseRuntimeCwdWorkspace(dir)).toBe(false);
    expect(shouldBootstrapWorkspaceInitFiles(dir)).toBe(true);
  });
});

describe("runCommandWithTimeout", () => {
  it("rejects an empty argv before spawning", async () => {
    await expect(runCommandWithTimeout([])).rejects.toThrow(
      "runCommandWithTimeout: empty argv",
    );
  });

  it("captures stdout, stderr, and a zero exit code", async () => {
    const result = await runCommandWithTimeout([
      process.execPath,
      "-e",
      "process.stdout.write('out-head'); process.stderr.write('err-head');",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("out-head");
    expect(result.stderr).toBe("err-head");
  });

  it("preserves a non-zero exit code and both streams", async () => {
    const result = await runCommandWithTimeout([
      process.execPath,
      "-e",
      "process.stdout.write('still-out'); process.stderr.write('still-err'); process.exit(3);",
    ]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("still-out");
    expect(result.stderr).toBe("still-err");
  });

  it("runs with the requested cwd", async () => {
    const dir = await makeTmp("eliza-ws-cwd-");
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write(process.cwd())"],
      { cwd: dir },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(await fs.realpath(dir));
  });

  it("forwards a custom env object rather than inheriting a missing key", async () => {
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stdout.write(process.env.ELIZA_WS_TEST_MARKER ?? '')",
      ],
      { env: { ...process.env, ELIZA_WS_TEST_MARKER: "from-env" } },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("from-env");
  });

  it("does not install a timer when timeoutMs is 0", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "process.stdout.write('ok')"],
      { timeoutMs: 0 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("rejects when the timeout fires", async () => {
    await expect(
      runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)",
        ],
        { timeoutMs: 200 },
      ),
    ).rejects.toThrow(/timed out after 200ms/);
  });

  it("rejects when the process cannot be spawned", async () => {
    await expect(
      runCommandWithTimeout(["eliza-ws-no-such-command-9f3a2c"]),
    ).rejects.toThrow();
  });
});

describe("isDefaultBoilerplate", () => {
  it("matches every current template written by ensureAgentWorkspace", async () => {
    const dir = await makeTmp("eliza-ws-bp-");
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    const files = await loadWorkspaceInitFiles(dir);
    const present = files.filter((file) => !file.missing && file.content);
    expect(present.map((file) => file.name)).toEqual([
      "AGENTS.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
      "HEARTBEAT.md",
      "INIT.md",
    ]);
    for (const file of present) {
      expect(isDefaultBoilerplate(file.name, file.content ?? "")).toBe(true);
    }
  });

  it("matches legacy AGENTS.md and TOOLS.md boilerplate", () => {
    expect(isDefaultBoilerplate("AGENTS.md", LEGACY_AGENTS_TEMPLATE)).toBe(
      true,
    );
    expect(isDefaultBoilerplate("TOOLS.md", LEGACY_TOOLS_TEMPLATE)).toBe(true);
  });

  it("treats CRLF, trailing spaces, extra blank lines, and case as the same template", async () => {
    const dir = await makeTmp("eliza-ws-bp-norm-");
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    const noisy = `\n\n${agents
      .replace(/\n\n/g, "\n\n\n\n")
      .replace(/\n/g, "  \r\n")
      .toUpperCase()}\n\n`;
    expect(isDefaultBoilerplate("AGENTS.md", noisy)).toBe(true);
  });

  it("returns false for edited content, unknown names, and files with no template", async () => {
    const dir = await makeTmp("eliza-ws-bp-edit-");
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    const agents = await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8");
    expect(isDefaultBoilerplate("AGENTS.md", `${agents}\ncustom note\n`)).toBe(
      false,
    );
    expect(isDefaultBoilerplate("AGENTS.md", LEGACY_TOOLS_TEMPLATE)).toBe(
      false,
    );
    expect(isDefaultBoilerplate("NOT.md", agents)).toBe(false);
    expect(isDefaultBoilerplate("MEMORY.md", "anything at all")).toBe(false);
    expect(isDefaultBoilerplate("memory.md", "")).toBe(false);
    expect(isDefaultBoilerplate("AGENTS.md", "")).toBe(false);
  });
});

describe("ensureAgentWorkspace", () => {
  it("creates the directory and returns only dir when init files are not requested", async () => {
    const dir = await makeTmp("eliza-ws-noinit-");
    const nested = path.join(dir, "workspace");
    const result = await ensureAgentWorkspace({ dir: nested });
    expect(result).toEqual({ dir: resolveUserPath(nested) });
    const names = await fs.readdir(result.dir);
    expect(names).toEqual([]);
  });

  it("trims surrounding whitespace on the requested dir", async () => {
    const dir = await makeTmp("eliza-ws-trim-");
    const nested = path.join(dir, "trimmed");
    const result = await ensureAgentWorkspace({ dir: `  ${nested}  ` });
    expect(result.dir).toBe(resolveUserPath(nested));
    await fs.stat(result.dir);
  });

  it("seeds every init file and git-inits a brand-new workspace", async () => {
    const dir = await makeTmp("eliza-ws-new-");
    const result = await ensureAgentWorkspace({
      dir,
      ensureInitFiles: true,
    });
    expect(result.dir).toBe(resolveUserPath(dir));
    expect(result.agentsPath).toBe(path.join(result.dir, "AGENTS.md"));
    expect(result.toolsPath).toBe(path.join(result.dir, "TOOLS.md"));
    expect(result.identityPath).toBe(path.join(result.dir, "IDENTITY.md"));
    expect(result.userPath).toBe(path.join(result.dir, "USER.md"));
    expect(result.heartbeatPath).toBe(path.join(result.dir, "HEARTBEAT.md"));
    expect(result.initPath).toBe(path.join(result.dir, "INIT.md"));
    for (const name of INIT_NAMES) {
      await fs.access(path.join(result.dir, name));
    }
    const gitStat = await fs.stat(path.join(result.dir, ".git"));
    expect(gitStat.isDirectory()).toBe(true);
  });

  it("does not clobber user edits, write INIT.md, or git-init an existing workspace", async () => {
    const dir = await makeTmp("eliza-ws-existing-");
    const custom = "user-edited AGENTS.md — keep this complete payload";
    await fs.writeFile(path.join(dir, "AGENTS.md"), custom);
    const result = await ensureAgentWorkspace({
      dir,
      ensureInitFiles: true,
    });
    expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf-8")).toBe(
      custom,
    );
    await fs.access(path.join(dir, "TOOLS.md"));
    await expect(fs.access(path.join(dir, "INIT.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(dir, ".git"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.initPath).toBe(path.join(result.dir, "INIT.md"));
  });

  it("skips git init when a brand-new workspace already has .git", async () => {
    const dir = await makeTmp("eliza-ws-hasgit-");
    await fs.mkdir(path.join(dir, ".git"));
    await fs.writeFile(path.join(dir, ".git", "sentinel"), "keep");
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    expect(await fs.readFile(path.join(dir, ".git", "sentinel"), "utf-8")).toBe(
      "keep",
    );
    await fs.access(path.join(dir, "INIT.md"));
  });

  it("uses the default workspace dir when no dir is provided", async () => {
    const dir = await makeTmp("eliza-ws-default-");
    const previous = process.env.ELIZA_WORKSPACE_DIR;
    process.env.ELIZA_WORKSPACE_DIR = dir;
    try {
      const result = await ensureAgentWorkspace();
      expect(result.dir).toBe(resolveUserPath(dir));
      expect(result.agentsPath).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.ELIZA_WORKSPACE_DIR;
      } else {
        process.env.ELIZA_WORKSPACE_DIR = previous;
      }
    }
  });
});

describe("loadWorkspaceInitFiles", () => {
  it("returns the six init files as missing in order when the directory is empty", async () => {
    const dir = await makeTmp("eliza-ws-load-empty-");
    const files = await loadWorkspaceInitFiles(dir);
    expect(files.map((file) => file.name)).toEqual([...INIT_NAMES]);
    for (const file of files) {
      expect(file.missing).toBe(true);
      expect(file.content).toBeUndefined();
      expect(file.path).toBe(path.join(resolveUserPath(dir), file.name));
    }
  });

  it("loads complete contents for every present init file, including a large MEMORY.md", async () => {
    const dir = await makeTmp("eliza-ws-load-full-");
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    const memory = `MEMORY_HEAD${"m".repeat(50_000)}MEMORY_TAIL`;
    await fs.writeFile(path.join(dir, "MEMORY.md"), memory);
    const files = await loadWorkspaceInitFiles(dir);
    expect(files.map((file) => file.name)).toEqual([
      ...INIT_NAMES,
      "MEMORY.md",
    ]);
    for (const file of files) {
      expect(file.missing).toBe(false);
      expect(file.content?.length).toBeGreaterThan(0);
    }
    const loadedMemory = files.find((file) => file.name === "MEMORY.md");
    expect(loadedMemory?.content).toBe(memory);
    expect(loadedMemory?.content?.startsWith("MEMORY_HEAD")).toBe(true);
    expect(loadedMemory?.content?.endsWith("MEMORY_TAIL")).toBe(true);
  });

  it("omits MEMORY.md when it is absent rather than marking it missing", async () => {
    const dir = await makeTmp("eliza-ws-load-nomem-");
    await ensureAgentWorkspace({ dir, ensureInitFiles: true });
    const files = await loadWorkspaceInitFiles(dir);
    expect(files.some((file) => file.name === "MEMORY.md")).toBe(false);
    expect(files.some((file) => file.name === "memory.md")).toBe(false);
    expect(files).toHaveLength(6);
  });

  it("dedups MEMORY.md and memory.md that resolve to the same realpath", async () => {
    const dir = await makeTmp("eliza-ws-load-dedup-");
    const payload = "single-inode-memory";
    await fs.writeFile(path.join(dir, "MEMORY.md"), payload);
    try {
      await fs.symlink("MEMORY.md", path.join(dir, "memory.md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    const files = await loadWorkspaceInitFiles(dir);
    const memoryFiles = files.filter(
      (file) => file.name === "MEMORY.md" || file.name === "memory.md",
    );
    expect(memoryFiles).toHaveLength(1);
    expect(memoryFiles[0]?.name).toBe("MEMORY.md");
    expect(memoryFiles[0]?.content).toBe(payload);
  });

  it("rejects when an init path exists but is not a readable file", async () => {
    const dir = await makeTmp("eliza-ws-load-eisdir-");
    await fs.mkdir(path.join(dir, "AGENTS.md"));
    await expect(loadWorkspaceInitFiles(dir)).rejects.toThrow();
  });
});

describe("filterInitFilesForSession", () => {
  const allFiles: WorkspaceInitFile[] = [
    initFile("AGENTS.md"),
    initFile("TOOLS.md"),
    initFile("IDENTITY.md", true),
    initFile("USER.md"),
    initFile("HEARTBEAT.md"),
    initFile("INIT.md"),
    initFile("MEMORY.md"),
  ];

  it("returns the full list for a missing, empty, or primary session key", () => {
    expect(filterInitFilesForSession(allFiles)).toEqual(allFiles);
    expect(filterInitFilesForSession(allFiles, "")).toEqual(allFiles);
    expect(filterInitFilesForSession(allFiles, "agent:bot:main")).toEqual(
      allFiles,
    );
  });

  it("returns an empty list unchanged", () => {
    expect(filterInitFilesForSession([])).toEqual([]);
    expect(filterInitFilesForSession([], "agent:bot:subagent:s")).toEqual([]);
  });

  it("keeps a single allowlisted file and drops a single non-allowlisted file for a subagent", () => {
    const agents = [initFile("AGENTS.md")];
    const user = [initFile("USER.md")];
    expect(filterInitFilesForSession(agents, "agent:bot:subagent:s")).toEqual(
      agents,
    );
    expect(filterInitFilesForSession(user, "agent:bot:subagent:s")).toEqual([]);
  });

  it("narrows a subagent session to AGENTS.md and TOOLS.md in input order", () => {
    const reordered: WorkspaceInitFile[] = [
      initFile("TOOLS.md"),
      initFile("USER.md"),
      initFile("AGENTS.md"),
      initFile("MEMORY.md"),
    ];
    expect(
      filterInitFilesForSession(reordered, "agent:bot:subagent:child"),
    ).toEqual([initFile("TOOLS.md"), initFile("AGENTS.md")]);
  });
});
