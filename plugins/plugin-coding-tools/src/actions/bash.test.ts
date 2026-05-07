import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SandboxService,
  SessionCwdService,
  ShellTaskService,
} from "../services/index.js";
import {
  SANDBOX_SERVICE,
  SESSION_CWD_SERVICE,
  SHELL_TASK_SERVICE,
} from "../types.js";
import { bashAction } from "./bash.js";

interface RuntimeOptions {
  workspaceRoots?: string;
  bashTimeoutMs?: number;
  bashBgBudgetMs?: number;
}

async function makeRuntime(opts: RuntimeOptions = {}): Promise<{
  runtime: IAgentRuntime;
  sandbox: SandboxService;
  session: SessionCwdService;
  tasks: ShellTaskService;
}> {
  const settings: Record<string, unknown> = {};
  if (opts.workspaceRoots) settings.CODING_TOOLS_WORKSPACE_ROOTS = opts.workspaceRoots;
  if (opts.bashTimeoutMs !== undefined)
    settings.CODING_TOOLS_BASH_TIMEOUT_MS = opts.bashTimeoutMs;
  if (opts.bashBgBudgetMs !== undefined)
    settings.CODING_TOOLS_BASH_BG_BUDGET_MS = opts.bashBgBudgetMs;

  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
  } as unknown as IAgentRuntime;

  const sandbox = await SandboxService.start(runtime);
  const session = await SessionCwdService.start(runtime);
  const tasks = await ShellTaskService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(SESSION_CWD_SERVICE, session);
  services.set(SHELL_TASK_SERVICE, tasks);

  return { runtime, sandbox, session, tasks };
}

function makeMessage(roomId = "11111111-aaaa-bbbb-cccc-222222222222"): Memory {
  return {
    id: "33333333-3333-3333-3333-333333333333" as UUID,
    entityId: "44444444-4444-4444-4444-444444444444" as UUID,
    roomId: roomId as UUID,
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    content: { text: "" },
    createdAt: Date.now(),
  } as unknown as Memory;
}

describe("bashAction", () => {
  let started: ShellTaskService | undefined;

  beforeEach(() => {
    started = undefined;
  });

  afterEach(async () => {
    if (started) await started.stop();
  });

  it("runs a simple foreground command (echo hello)", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime, tasks } = await makeRuntime({ workspaceRoots: tmpRoot });
    started = tasks;

    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "echo hello" },
    );

    expect(result.success).toBe(true);
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("hello");
    expect(result.text).toContain("[exit 0]");
  });

  it("denies a command on the sandbox denylist", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime, tasks } = await makeRuntime({ workspaceRoots: tmpRoot });
    started = tasks;

    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "rm -rf /" },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("command_denied");
  });

  it("returns a timeout failure when the command exceeds its budget", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime, tasks } = await makeRuntime({
      workspaceRoots: tmpRoot,
      bashBgBudgetMs: 60_000,
    });
    started = tasks;

    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "sleep 5", timeout: 200 },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("timeout");
  });

  it("respects an explicit cwd inside the sandbox roots", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime, tasks } = await makeRuntime({ workspaceRoots: tmpRoot });
    started = tasks;

    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "pwd", cwd: tmpRoot },
    );

    expect(result.success).toBe(true);
    expect(result.text).toContain(tmpRoot);
  });

  it("returns immediately with a task_id when run_in_background is true", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime, tasks } = await makeRuntime({ workspaceRoots: tmpRoot });
    started = tasks;

    const startResult = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "sleep 0.2", run_in_background: true },
    );

    expect(startResult.success).toBe(true);
    const data = startResult.data as Record<string, unknown> | undefined;
    expect(data).toBeDefined();
    const taskId = data?.task_id as string | undefined;
    expect(typeof taskId).toBe("string");
    expect(startResult.text).toContain("Started background task");

    const final = await tasks.waitFor(taskId!, 5_000);
    expect(final?.status).toBe("completed");
  });
});
