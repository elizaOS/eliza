import { CapabilityError, type IAgentRuntime, type UUID } from "@elizaos/core";
import type { CommandResult, EntryInfo } from "e2b";
import { describe, expect, it, vi } from "vitest";
import {
  E2BSatelliteCapabilityRouterService,
  type E2BSatelliteRunnerConfig,
  type E2BSandboxClient,
  type E2BSandboxFactory,
  resolveE2BSatelliteRunnerConfig,
} from "./e2b-capability-router.ts";

class FakeFiles {
  readonly listCalls: string[] = [];
  readonly readCalls: string[] = [];
  readonly writeCalls: Array<{ path: string; text: string }> = [];

  constructor(private readonly entries: EntryInfo[] = []) {}

  async list(path: string): Promise<EntryInfo[]> {
    this.listCalls.push(path);
    return this.entries;
  }

  async read(
    path: string,
    opts?: { format?: "text"; requestTimeoutMs?: number },
  ): Promise<string>;
  async read(
    path: string,
    opts: { format: "bytes"; requestTimeoutMs?: number },
  ): Promise<Uint8Array>;
  async read(
    path: string,
    opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
  ): Promise<string | Uint8Array> {
    this.readCalls.push(path);
    if (opts?.format === "bytes") return new TextEncoder().encode("file text");
    return "file text";
  }

  async write(
    path: string,
    data: string,
  ): Promise<{ name: string; path: string; type: EntryInfo["type"] }> {
    this.writeCalls.push({ path, text: data });
    return { name: path.split("/").pop() ?? path, path, type: FILE_ENTRY };
  }
}

class FakeCommands {
  readonly runCalls: Array<{ cmd: string; cwd?: string }> = [];

  async run(cmd: string, opts: { cwd?: string } = {}): Promise<CommandResult> {
    this.runCalls.push({ cmd, cwd: opts.cwd });
    return {
      exitCode: 0,
      stdout: cmd.startsWith("mkdir ") ? "" : `ran ${cmd}\n`,
      stderr: "",
    };
  }
}

class FakeSandbox implements E2BSandboxClient {
  readonly sandboxId = "sbx_test";
  readonly files: FakeFiles;
  readonly commands = new FakeCommands();
  readonly kill = vi.fn(async () => {});

  constructor(entries: EntryInfo[] = []) {
    this.files = new FakeFiles(entries);
  }
}

class FakeFactory implements E2BSandboxFactory {
  readonly configs: E2BSatelliteRunnerConfig[] = [];

  constructor(readonly sandbox = new FakeSandbox()) {}

  async create(config: E2BSatelliteRunnerConfig): Promise<E2BSandboxClient> {
    this.configs.push(config);
    return this.sandbox;
  }
}

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  const runtime: Partial<IAgentRuntime> = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    character: { name: "E2B Test" },
    getSetting: (key: string) => settings[key],
    getService: () => null,
  };
  return runtime as IAgentRuntime;
}

function makeConfig(
  overrides: Partial<E2BSatelliteRunnerConfig> = {},
): E2BSatelliteRunnerConfig {
  return {
    enabled: true,
    apiKey: "test-key",
    workdir: "/workspace",
    hostWorkspaceRoot: "/repo",
    timeoutMs: 60_000,
    requestTimeoutMs: 10_000,
    keepAlive: false,
    allowInternetAccess: true,
    envs: {},
    metadata: {},
    ...overrides,
  };
}

const FILE_ENTRY = "file" as EntryInfo["type"];
const DIR_ENTRY = "dir" as EntryInfo["type"];

function entry(path: string, name: string, type: EntryInfo["type"]): EntryInfo {
  return {
    path,
    name,
    type,
    size: 12,
    mode: 0o644,
    permissions: "rw-r--r--",
    owner: "user",
    group: "user",
    modifiedTime: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("E2BSatelliteCapabilityRouterService", () => {
  it("resolves explicit E2B Satellite runner settings", () => {
    const config = resolveE2BSatelliteRunnerConfig(
      makeRuntime({
        ELIZA_CODING_SATELLITE_RUNNER: "e2b",
        E2B_API_KEY: "key",
        ELIZA_E2B_WORKDIR: "/work",
        ELIZA_E2B_HOST_WORKSPACE_ROOT: "/repo",
      }),
    );

    expect(config.enabled).toBe(true);
    expect(config.apiKey).toBe("key");
    expect(config.workdir).toBe("/work");
    expect(config.hostWorkspaceRoot).toBe("/repo");
  });

  it("reports structured unavailable when credentials are missing", async () => {
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig({ apiKey: undefined, accessToken: undefined }),
      new FakeFactory(),
    );

    await expect(
      service.pty.runCommand({ command: "echo nope" }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      capability: "pty",
    });
  });

  it("runs commands in the E2B Satellite runner and maps host workspace paths", async () => {
    const sandbox = new FakeSandbox();
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.pty.runCommand({
      command: "npm",
      args: ["test"],
      cwd: "/repo/src",
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(result.output).toContain("ran npm 'test'");
    expect(sandbox.commands.runCalls[1]).toMatchObject({
      cmd: "npm 'test'",
      cwd: "/workspace/src",
    });
  });

  it("lists E2B Satellite runner files with hidden and ignore filtering", async () => {
    const sandbox = new FakeSandbox([
      entry("/workspace/src", "src", DIR_ENTRY),
      entry("/workspace/.env", ".env", FILE_ENTRY),
      entry("/workspace/build.log", "build.log", FILE_ENTRY),
    ]);
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.fs.list({
      path: "/repo",
      ignore: ["*.log"],
      includeHidden: false,
    });

    expect(result.path).toBe("/workspace");
    expect(result.entries.map((item) => item.name)).toEqual(["src"]);
    expect(sandbox.files.listCalls).toContain("/workspace");
  });

  it("routes git helpers through sandbox command execution", async () => {
    const sandbox = new FakeSandbox();
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(sandbox),
    );

    const result = await service.git.commandRun({
      root: "/repo",
      args: ["status", "--short"],
    });

    expect(result.operation.status).toBe("completed");
    expect(sandbox.commands.runCalls.at(-1)).toMatchObject({
      cmd: "git 'status' '--short'",
      cwd: "/workspace",
    });
  });

  it("rejects host paths outside the mapped workspace", async () => {
    const service = new E2BSatelliteCapabilityRouterService(
      makeRuntime(),
      makeConfig(),
      new FakeFactory(),
    );

    await expect(
      service.fs.readText({ path: "/outside/file.ts" }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});
