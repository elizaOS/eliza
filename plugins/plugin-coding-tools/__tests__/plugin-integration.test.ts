/**
 * Integration tests for the assembled `codingToolsPlugin` — service registration,
 * action wiring, and auto-enable gating — exercised in-process against the real
 * filesystem.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  type Service,
  type UUID,
} from "@elizaos/core";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
  vi,
} from "vitest";
import codingToolsPlugin, {
  FILE_STATE_SERVICE,
  FileStateService,
  RIPGREP_SERVICE,
  RipgrepService,
  SANDBOX_SERVICE,
  SandboxService,
  SESSION_CWD_SERVICE,
  SessionCwdService,
} from "../src/index.ts";

describe("@elizaos/plugin-coding-tools — plugin export shape", () => {
  it("validate ignores CODING_TOOLS_DISABLE — kill switch was removed", async () => {
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000000",
      getSetting: (key: string) =>
        key === "CODING_TOOLS_DISABLE" ? true : undefined,
      getService: () => null,
    } as IAgentRuntime;
    const message = { roomId: "r" } as Memory;
    for (const action of codingToolsPlugin.actions ?? []) {
      const ok = await action.validate?.(runtime, message);
      expect(ok, action.name).toBe(true);
    }
  });

  it("auto-enables only for configured terminal-capable environments", () => {
    const shouldEnable = codingToolsPlugin.autoEnable?.shouldEnable;
    expect(shouldEnable).toBeTypeOf("function");
    if (!shouldEnable) return;

    expect(shouldEnable({}, { features: {} })).toBe(false);
    expect(shouldEnable({}, { features: { codingTools: true } })).toBe(true);
    expect(
      shouldEnable(
        { ELIZA_RUNTIME_MODE: "local-yolo" },
        { features: { codingTools: true } },
      ),
    ).toBe(true);
    expect(
      shouldEnable(
        { ELIZA_PLATFORM: "ios" },
        { features: { "coding-agent": true } },
      ),
    ).toBe(false);
    expect(
      shouldEnable(
        { ELIZA_BUILD_VARIANT: "store" },
        { features: { codingTools: true } },
      ),
    ).toBe(false);
    expect(
      shouldEnable(
        { ELIZA_PLATFORM: "ios" },
        { features: { codingTools: true } },
      ),
    ).toBe(false);
    expect(
      shouldEnable(
        { ELIZA_PLATFORM: "android", ELIZA_RUNTIME_MODE: "local-yolo" },
        { features: { "coding-agent": {} } },
      ),
    ).toBe(true);
    expect(
      shouldEnable(
        { ANDROID_ROOT: "/system", RUNTIME_MODE: "remote" },
        { features: { codingTools: { enabled: false } } },
      ),
    ).toBe(false);
  });

  it("disposes every registered long-lived service", async () => {
    const stop = {
      sandbox: vi.fn(async () => undefined),
      fileState: vi.fn(async () => undefined),
      session: vi.fn(async () => undefined),
      ripgrep: vi.fn(async () => undefined),
    };
    const instances = new Map<string, { stop: () => Promise<void> }>([
      [SandboxService.serviceType, { stop: stop.sandbox }],
      [FileStateService.serviceType, { stop: stop.fileState }],
      [SessionCwdService.serviceType, { stop: stop.session }],
      [RipgrepService.serviceType, { stop: stop.ripgrep }],
    ]);
    const runtime = {
      getService: (serviceType: string) => instances.get(serviceType),
    } as IAgentRuntime;

    await codingToolsPlugin.dispose?.(runtime);

    expect(stop.sandbox).toHaveBeenCalledOnce();
    expect(stop.fileState).toHaveBeenCalledOnce();
    expect(stop.session).toHaveBeenCalledOnce();
    expect(stop.ripgrep).toHaveBeenCalledOnce();
  });
});

describe("@elizaos/plugin-coding-tools — filesystem and shell integration", () => {
  let tmpDir: string;
  let runtime: IAgentRuntime;
  const services = new Map<string, Service>();

  beforeAll(async () => {
    tmpDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "ct-integ-")),
    );
    await fs.writeFile(
      path.join(tmpDir, "needle.txt"),
      "this file contains the NEEDLE word\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, "other.md"),
      "# heading\n\nbody text\n",
      "utf8",
    );
    await fs.mkdir(path.join(tmpDir, "internal", "config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmpDir, "internal", "config", "config.go"),
      "package config\n",
      "utf8",
    );

    runtime = {
      agentId: "00000000-0000-0000-0000-000000000000" as UUID,
      runtimeInstanceId: "coding-tools-integration-runtime",
      actions: codingToolsPlugin.actions ?? [],
      getRoom: async () => ({ worldId: "coding-tools-smoke-world" }),
      getWorld: async () => ({
        id: "coding-tools-smoke-world",
        metadata: { ownership: { ownerId: makeMessage().entityId } },
      }),
      getSetting: (_key: string) => undefined,
      getService: (key: string) => services.get(key) ?? null,
      redactSecrets: (text: string) => text,
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as IAgentRuntime;

    const fileState = await FileStateService.start(runtime);
    services.set(FILE_STATE_SERVICE, fileState);
    const sandbox = await SandboxService.start(runtime);
    services.set(SANDBOX_SERVICE, sandbox);
    const session = await SessionCwdService.start(runtime);
    services.set(SESSION_CWD_SERVICE, session);
    const rg = await RipgrepService.start(runtime);
    services.set(RIPGREP_SERVICE, rg);
    session.setCwd("smoke-room", tmpDir);
  });

  afterAll(async () => {
    const stopped = await Promise.allSettled(
      [...services.values()].map((service) => service.stop()),
    );
    await fs.rm(tmpDir, { recursive: true, force: true });
    const failed = stopped.filter((result) => result.status === "rejected");
    if (failed.length) {
      throw new AggregateError(
        failed.map((result) => result.reason),
        "Service teardown failed",
      );
    }
  });

  function runFile(parameters: Record<string, unknown>) {
    return findAction("FILE").handler?.(runtime, makeMessage(), undefined, {
      parameters,
    });
  }

  function requireRipgrep(ctx: TestContext) {
    const service = services.get(RIPGREP_SERVICE);
    if (!(service instanceof RipgrepService))
      throw new Error("RipgrepService not started");
    try {
      execFileSync(service.binary(), ["--version"], { stdio: "ignore" });
    } catch {
      // error-policy:J4 An unavailable host binary makes only grep cases unavailable.
      ctx.skip(`ripgrep unavailable: '${service.binary()}' is not runnable`);
    }
  }

  function findAction(name: string) {
    const actions = codingToolsPlugin.actions ?? [];
    const a = actions.find((x) => x.name === name);
    if (!a) throw new Error(`action ${name} not found`);
    return a;
  }

  function makeMessage(text = ""): Memory {
    return {
      entityId: "00000000-0000-4000-8000-000000000001",
      roomId: "smoke-room",
      content: { text },
    } as Memory;
  }

  function guidedFileParameters(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      action: "glob",
      target: "workspace",
      file_path: "",
      path: "",
      content: "",
      old_string: "",
      new_string: "",
      replace_all: false,
      pattern: "",
      glob: "",
      type: "",
      output_mode: "files_with_matches",
      "-A": 0,
      "-B": 0,
      "-C": 0,
      case_insensitive: false,
      multiline: false,
      head_limit: 0,
      show_line_numbers: false,
      offset: 0,
      limit: 0,
      unit: "line",
      expectedRevision: "",
      ignore: [],
      encoding: "utf8",
      ...overrides,
    };
  }

  it("FILE action=read returns a known file's contents", async () => {
    const result = await runFile({
      action: "read",
      file_path: path.join(tmpDir, "needle.txt"),
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("NEEDLE");
  });

  it("FILE action=write creates a new file", async () => {
    const target = path.join(tmpDir, "smoke-out.txt");
    const result = await runFile({
      action: "write",
      file_path: target,
      content: "smoke ok",
    });
    expect(result.success).toBe(true);
    const written = await fs.readFile(target, "utf8");
    expect(written).toBe("smoke ok");
  });

  it("SHELL echo hello", async () => {
    const action = findAction("SHELL");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: { command: "echo smoke-bash-ok", cwd: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("--- stdout ---\nsmoke-bash-ok");
    expect(result.text).toContain("[exit 0]");
  });

  it("SHELL planned action executes the exact structured command despite history-like prose", async () => {
    const command = "echo planned-shell-authority";
    const result = await executePlannedToolCall(
      runtime,
      {
        message: makeMessage(
          "show command history under the history directory",
        ),
        activeContexts: ["code"],
        userRoles: ["OWNER"],
      },
      { name: "SHELL", params: { command, cwd: tmpDir } },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("planned-shell-authority");
    expect(result.data).toMatchObject({ command });
  });

  it("FILE action=glob lists *.txt files", async () => {
    const result = await runFile({
      action: "glob",
      pattern: "*.txt",
      path: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
  });

  it("FILE action=ls shows fixture entries", async () => {
    const result = await runFile({ action: "ls", path: tmpDir });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
    expect(result.text).toContain("other.md");
  });

  it("FILE action=grep finds the NEEDLE token via the plugin's own ripgrep resolution", async (ctx) => {
    requireRipgrep(ctx);
    const result = await runFile({
      action: "grep",
      pattern: "NEEDLE",
      path: tmpDir,
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
  });

  it("FILE dispatches the exact dense guided-decode glob shape from a live coding trajectory", async () => {
    const result = await runFile(
      guidedFileParameters({
        action: "glob",
        path: "**/config.go",
        glob: "**/internal/config/config.go",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain(
      path.join(tmpDir, "internal", "config", "config.go"),
    );
  });

  it.each([
    { pattern: "../outside/*.txt", path: ".", glob: "" },
    { pattern: "", path: "../outside/*.txt", glob: "" },
  ])(
    "FILE rejects dense glob traversal from canonical and path-fallback shapes",
    async (override) => {
      const result = await runFile(
        guidedFileParameters({
          action: "glob",
          ...override,
        }),
      );

      expect(result.success).toBe(false);
      expect(result.text).toContain("invalid_param");
      expect(result.text).toContain("must not traverse");
    },
  );

  it("FILE resolves an explicit relative glob root against the session cwd", async () => {
    const result = await runFile({
      action: "glob",
      pattern: "*.go",
      path: "internal/config",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain(
      path.join(tmpDir, "internal", "config", "config.go"),
    );
  });

  it("FILE treats dense decoder defaults as absent for a valid read", async () => {
    const result = await runFile(
      guidedFileParameters({
        action: "read",
        file_path: path.join(tmpDir, "needle.txt"),
      }),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("NEEDLE");
  });

  it("FILE preserves an explicit zero limit in a sparse read call", async () => {
    const result = await runFile({
      action: "read",
      file_path: path.join(tmpDir, "needle.txt"),
      limit: 0,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("limit must be positive safe integers");
  });

  it("FILE preserves an empty write payload while dropping unrelated decoder defaults", async () => {
    const target = path.join(tmpDir, "guided-empty.txt");
    const result = await runFile(
      guidedFileParameters({
        action: "write",
        file_path: target,
        content: "",
      }),
    );

    expect(result.success).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("");
  });

  it("FILE preserves an empty edit replacement while dropping unrelated decoder defaults", async () => {
    const target = path.join(tmpDir, "guided-edit.txt");
    await fs.writeFile(target, "remove me\nkeep me\n", "utf8");
    const readResult = await runFile({ action: "read", file_path: target });
    expect(readResult.success).toBe(true);

    const editResult = await runFile(
      guidedFileParameters({
        action: "edit",
        file_path: target,
        old_string: "remove me\n",
        new_string: "",
      }),
    );

    expect(editResult.success).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("keep me\n");
  });

  it("FILE ignores empty grep filters emitted by a dense decoder", async (ctx) => {
    requireRipgrep(ctx);
    const result = await runFile(
      guidedFileParameters({
        action: "grep",
        pattern: "package config",
        path: "internal/config",
        output_mode: "content",
        show_line_numbers: true,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("config.go");
  });

  it("FILE restores content-mode line-number defaults for a dense decoder false placeholder", async (ctx) => {
    requireRipgrep(ctx);
    const result = await runFile(
      guidedFileParameters({
        action: "grep",
        pattern: "package config",
        path: "internal/config",
        output_mode: "content",
        show_line_numbers: false,
      }),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("1:package config");
  });

  it("FILE preserves explicit show_line_numbers=false in a sparse grep call", async (ctx) => {
    requireRipgrep(ctx);
    const result = await runFile({
      action: "grep",
      pattern: "package config",
      path: "internal/config",
      output_mode: "content",
      show_line_numbers: false,
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("package config");
    expect(result.text).not.toContain("1:package config");
  });

  it("FILE routes a dense decoder's filtered ls request through glob", async () => {
    const result = await runFile(
      guidedFileParameters({
        action: "ls",
        path: ".",
        glob: "*",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
    expect(result.text).toContain("other.md");
  });

  it("FILE resolves a dense decoder's relative ls path when filters are empty", async () => {
    const result = await runFile(
      guidedFileParameters({ action: "ls", path: "." }),
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
    expect(result.text).toContain("other.md");
  });

  it("FILE preserves a missing-pattern failure for a dense grep call", async () => {
    const result = await runFile(
      guidedFileParameters({ action: "grep", path: "." }),
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param: pattern is required");
  });

  it("WORKTREE action=enter in a non-git dir fails cleanly", async () => {
    const action = findAction("WORKTREE");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: { action: "enter" },
    });
    expect(result.success).toBe(false);
    expect(result.text).toContain("io_error");
  });
});
