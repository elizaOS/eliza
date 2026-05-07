import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShellTaskService } from "../services/shell-task-service.js";
import { SHELL_TASK_SERVICE } from "../types.js";
import { taskStopAction } from "./task-stop.js";

async function makeRuntime(): Promise<{
  runtime: IAgentRuntime;
  tasks: ShellTaskService;
}> {
  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
  } as unknown as IAgentRuntime;
  const tasks = await ShellTaskService.start(runtime);
  services.set(SHELL_TASK_SERVICE, tasks);
  return { runtime, tasks };
}

function makeMessage(): Memory {
  return {
    id: "33333333-3333-3333-3333-333333333333" as UUID,
    entityId: "44444444-4444-4444-4444-444444444444" as UUID,
    roomId: "11111111-aaaa-bbbb-cccc-222222222222" as UUID,
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    content: { text: "" },
    createdAt: Date.now(),
  } as unknown as Memory;
}

describe("taskStopAction", () => {
  let svc: ShellTaskService | undefined;
  beforeEach(() => {
    svc = undefined;
  });
  afterEach(async () => {
    if (svc) await svc.stop();
  });

  it("returns invalid_param for an unknown task id", async () => {
    const { runtime, tasks } = await makeRuntime();
    svc = tasks;
    const result = await taskStopAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { task_id: "task-missing" },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
  });

  it("kills a running task and reports the new terminal status", async () => {
    const { runtime, tasks } = await makeRuntime();
    svc = tasks;
    const rec = tasks.start_({
      command: "sleep 30",
      cwd: path.resolve(os.tmpdir()),
    });
    expect(rec.status).toBe("running");

    const result = await taskStopAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { task_id: rec.id },
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.task_id).toBe(rec.id);
    // The task should have flipped out of "running" after SIGTERM.
    const status = String(data?.status ?? "");
    expect(["killed", "failed", "completed"]).toContain(status);
    expect(status).not.toBe("running");
  });

  it("returns success when the task already terminated", async () => {
    const { runtime, tasks } = await makeRuntime();
    svc = tasks;
    const rec = tasks.start_({
      command: "echo finished",
      cwd: path.resolve(os.tmpdir()),
    });
    await tasks.waitFor(rec.id, 5_000);

    const result = await taskStopAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { task_id: rec.id },
    );
    expect(result.success).toBe(true);
    expect(result.text).toMatch(/already (completed|failed|killed)/);
  });

  it("requires task_id", async () => {
    const { runtime, tasks } = await makeRuntime();
    svc = tasks;
    const result = await taskStopAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("missing_param");
  });
});
