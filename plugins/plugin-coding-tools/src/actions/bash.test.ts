import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { SandboxService, SessionCwdService } from "../services/index.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { bashAction } from "./bash.js";

interface RuntimeOptions {
  blockedPaths?: string;
  bashTimeoutMs?: number;
}

async function makeRuntime(opts: RuntimeOptions = {}): Promise<{
  runtime: IAgentRuntime;
  sandbox: SandboxService;
  session: SessionCwdService;
}> {
  const settings: Record<string, unknown> = {};
  if (opts.blockedPaths)
    settings.CODING_TOOLS_BLOCKED_PATHS = opts.blockedPaths;
  if (opts.bashTimeoutMs !== undefined)
    settings.CODING_TOOLS_BASH_TIMEOUT_MS = opts.bashTimeoutMs;

  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
  } as unknown as IAgentRuntime;

  const sandbox = await SandboxService.start(runtime);
  const session = await SessionCwdService.start(runtime);
  services.set(SANDBOX_SERVICE, sandbox);
  services.set(SESSION_CWD_SERVICE, session);

  return { runtime, sandbox, session };
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
  it("runs a simple foreground command (echo hello)", async () => {
    const { runtime } = await makeRuntime();
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

  it("rejects a cwd under the blocklist", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const blocked = path.join(tmpRoot, `blocked-${Date.now()}`);
    await fs.mkdir(blocked, { recursive: true });
    try {
      const { runtime } = await makeRuntime({ blockedPaths: blocked });
      const result = await bashAction.handler!(
        runtime,
        makeMessage(),
        undefined,
        { command: "pwd", cwd: blocked },
      );
      expect(result.success).toBe(false);
      expect(result.text).toContain("path_blocked");
    } finally {
      await fs.rm(blocked, { recursive: true, force: true });
    }
  });

  it("returns a timeout failure when the command exceeds its budget", async () => {
    const { runtime } = await makeRuntime();
    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "sleep 5", timeout: 200 },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("timeout");
  });

  it("respects an explicit cwd", async () => {
    const tmpRoot = path.resolve(os.tmpdir());
    const { runtime } = await makeRuntime();
    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "pwd", cwd: tmpRoot },
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain(tmpRoot);
  });

  it("returns command_failed when the command exits non-zero", async () => {
    const { runtime } = await makeRuntime();
    const result = await bashAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { command: "exit 7" },
    );
    expect(result.success).toBe(false);
    expect(result.text).toContain("command_failed");
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.exit_code).toBe(7);
  });
});
