/**
 * Integration tests for the assembled `codingToolsPlugin` — service registration,
 * action wiring, and auto-enable gating — exercised in-process against the real
 * filesystem.
 */
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("@elizaos/plugin-coding-tools — end-to-end smoke", () => {
  let tmpDir: string;
  let runtime: IAgentRuntime;
  let services: Map<string, Service>;
  const cleanup: Array<() => Promise<void>> = [];

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

    services = new Map();
    runtime = {
      agentId: "00000000-0000-0000-0000-000000000000" as UUID,
      runtimeInstanceId: "coding-tools-integration-runtime",
      actions: codingToolsPlugin.actions ?? [],
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
    const sandbox = await SandboxService.start(runtime);
    const session = await SessionCwdService.start(runtime);
    const rg = await RipgrepService.start(runtime);
    services.set(FILE_STATE_SERVICE, fileState);
    services.set(SANDBOX_SERVICE, sandbox);
    services.set(SESSION_CWD_SERVICE, session);
    services.set(RIPGREP_SERVICE, rg);
    cleanup.push(() => fileState.stop());
    cleanup.push(() => sandbox.stop());
    cleanup.push(() => session.stop());
    cleanup.push(() => rg.stop());
    session.setCwd("smoke-room", tmpDir);
  });

  afterAll(async () => {
    for (const fn of cleanup) {
      try {
        await fn();
      } catch {
        // ignore
      }
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function findAction(name: string) {
    const actions = codingToolsPlugin.actions ?? [];
    const a = actions.find((x) => x.name === name);
    if (!a) throw new Error(`action ${name} not found`);
    return a;
  }

  function makeMessage(text = ""): Memory {
    return { roomId: "smoke-room", content: { text } } as Memory;
  }

  it("FILE action=read returns a known file's contents", async () => {
    const action = findAction("FILE");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: {
        action: "read",
        file_path: path.join(tmpDir, "needle.txt"),
      },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("NEEDLE");
  });

  it("FILE action=write creates a new file", async () => {
    const action = findAction("FILE");
    const target = path.join(tmpDir, "smoke-out.txt");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: { action: "write", file_path: target, content: "smoke ok" },
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
    expect(result.text).toContain("smoke-bash-ok");
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
    const action = findAction("FILE");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: { action: "glob", pattern: "*.txt", path: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
  });

  it("FILE action=ls shows fixture entries", async () => {
    const action = findAction("FILE");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: { action: "ls", path: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
    expect(result.text).toContain("other.md");
  });

  it("FILE action=grep finds the NEEDLE token via the plugin's own ripgrep resolution", async (ctx) => {
    // The service under test IS the resolution path: RipgrepService.start()
    // resolved either the bundled `@vscode/ripgrep` binary or a system `rg`.
    // Assert that resolution produced a runnable binary; when neither exists
    // on the host, skip VISIBLY (never a silent vacuous pass), without ever
    // poking a substitute path into the service.
    const rg = services.get(RIPGREP_SERVICE) as RipgrepService | undefined;
    expect(rg, "RipgrepService must be started by the harness").toBeDefined();
    if (!rg) return;
    const binary = rg.binary();
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync(binary, ["--version"], { stdio: "ignore" });
    } catch {
      ctx.skip(
        `ripgrep unavailable: RipgrepService resolved '${binary}' but it is not runnable on this host`,
      );
      return;
    }
    const action = findAction("FILE");
    const result = await action.handler?.(runtime, makeMessage(), undefined, {
      parameters: { action: "grep", pattern: "NEEDLE", path: tmpDir },
    });
    expect(result.success).toBe(true);
    expect(result.text).toContain("needle.txt");
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
