/**
 * A Dedicated turn that outlives the bridge deadline is still running in the
 * sandbox, which finishes, persists and bills it. The bridge must report that
 * outcome as unknown, not as an unreachable sandbox that callers may retry
 * with a second turn for the same message.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { agentSandboxesRepository } from "../../../../db/repositories/agent-sandboxes";
import { customSandbox } from "../test-support/fixtures.js";
import { ActiveSandboxBridge, type SandboxBridgeHost } from "./active.js";
import { BRIDGE_TURN_IN_PROGRESS_CODE } from "./contracts.js";

function dedicatedSandbox() {
  return {
    ...customSandbox(),
    execution_tier: "dedicated-always" as const,
    bridge_url: "http://10.0.0.7:3100",
  };
}

function hostWithBridge(fetchAgentApi: SandboxBridgeHost["fetchAgentApi"]): SandboxBridgeHost {
  return {
    fetchAgentApi,
  } as unknown as SandboxBridgeHost;
}

const rpc = {
  jsonrpc: "2.0" as const,
  id: "turn-1",
  method: "message.send",
  params: { text: "plan my week", roomId: "room-1" },
};

describe("native bridge turn past the deadline", () => {
  afterEach(() => {
    spyOn(agentSandboxesRepository, "findRunningSandbox").mockRestore();
  });

  test("reports the turn as still running instead of an unreachable sandbox", async () => {
    const sandbox = dedicatedSandbox();
    spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(sandbox);
    const calls: string[] = [];
    const bridge = new ActiveSandboxBridge(
      hostWithBridge(async (_rec, path) => {
        calls.push(path);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    );

    const response = await bridge.bridge(sandbox.id, sandbox.organization_id, rpc);

    expect(response.error).toEqual({
      code: BRIDGE_TURN_IN_PROGRESS_CODE,
      message: "Sandbox turn still running after 60000 ms; outcome unknown",
    });
    // No REST attempt follows: the same message must not run a second time.
    expect(calls).toEqual(["/bridge"]);
  });

  test("a transport failure is still an unreachable sandbox", async () => {
    const sandbox = dedicatedSandbox();
    spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(sandbox);
    const bridge = new ActiveSandboxBridge(
      hostWithBridge(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const response = await bridge.bridge(sandbox.id, sandbox.organization_id, rpc);

    expect(response.error).toEqual({
      code: -32000,
      message: "Sandbox bridge is unreachable",
    });
  });
});
