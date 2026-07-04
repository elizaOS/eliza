/**
 * Real-error-path tests for the SHELL action (#12273): drive the action against
 * a genuinely missing binary and a genuinely failing command through the *real*
 * host shell (no capability router, no mocked failure) and assert the failure
 * surfaces as `success: false` + `result.error` — the shape the planner loop
 * shows the model. Guards the fallback-slop invariant that a shell failure is
 * never repackaged as success-shaped output.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SandboxService, SessionCwdService } from "../services/index.js";
import { SANDBOX_SERVICE, SESSION_CWD_SERVICE } from "../types.js";
import { shellAction } from "./bash.js";

// The assertions pin bash exit-code framing (127 = command not found), so the
// suite targets POSIX hosts; the Windows path routes to powershell separately.
const describeIfPosix = process.platform === "win32" ? describe.skip : describe;

async function makeHostRuntime(): Promise<IAgentRuntime> {
  const services = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(<T>(type: string) => services.get(type) as T | null),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  services.set(SANDBOX_SERVICE, await SandboxService.start(runtime));
  services.set(SESSION_CWD_SERVICE, await SessionCwdService.start(runtime));
  return runtime;
}

function makeMessage(text = ""): Memory {
  return {
    id: "33333333-3333-3333-3333-333333333333" as UUID,
    entityId: "44444444-4444-4444-4444-444444444444" as UUID,
    roomId: "11111111-aaaa-bbbb-cccc-222222222222" as UUID,
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

describeIfPosix("SHELL action real error paths", () => {
  it("surfaces a missing binary as success:false + result.error (exit 127)", async () => {
    const runtime = await makeHostRuntime();

    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      {
        command: "definitely-not-a-real-binary-xyzzy-12345 --version",
      },
    );

    // The failure reaches the caller unmasked — not a fabricated success.
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error?.message)).toContain(
      "command exited with code 127",
    );
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.exit_code).toBe(127);
    // The real shell diagnostic (not a canned default) is carried through.
    expect(String(data?.output ?? "")).toMatch(/not found|No such file/i);
  });

  it("surfaces a failing command (unreadable path) as success:false + result.error", async () => {
    const runtime = await makeHostRuntime();

    const result = await shellAction.handler?.(
      runtime,
      makeMessage(),
      undefined,
      {
        command: "cat /no/such/path/eliza-12273-does-not-exist",
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    const data = result.data as Record<string, unknown> | undefined;
    expect(data?.exit_code).not.toBe(0);
    expect(String(result.error?.message)).toContain("command exited with code");
  });
});
