/**
 * Real-error-path test for the COMPUTER_USE action boundary (#12273): a
 * genuinely failing platform operation (spawning a binary that does not
 * exist — no mocks of the failing dependency) must surface to the caller as
 * `success:false` + `result.error`, which is what the planner loop shows the
 * model. Guards against any regression toward catch-and-return-success.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";
import { useComputerAction } from "../actions/use-computer.js";
import { ComputerUseService } from "../services/computer-use-service.js";

const MISSING_BINARY =
  process.platform === "win32"
    ? "C:\\\\eliza-definitely-missing\\\\no-such-binary-12273.exe"
    : "/eliza-definitely-missing/no-such-binary-12273";

function makeRuntime(): {
  runtime: IAgentRuntime;
  attach: (service: ComputerUseService) => void;
} {
  let service: ComputerUseService | null = null;
  const runtime = {
    character: {},
    getSetting: (key: string) =>
      key === "COMPUTER_USE_APPROVAL_MODE" ? "full_control" : undefined,
    getService: (name: string) => (name === "computeruse" ? service : null),
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
  return {
    runtime,
    attach: (s) => {
      service = s;
    },
  };
}

const message = {
  id: "00000000-0000-0000-0000-000000000001",
  entityId: "00000000-0000-0000-0000-000000000002",
  agentId: "00000000-0000-0000-0000-000000000003",
  roomId: "00000000-0000-0000-0000-000000000004",
  content: { action: "launch", app: MISSING_BINARY },
} as unknown as Memory;

describe("COMPUTER_USE surfaces real platform failures as success:false + error", () => {
  let stopService: (() => Promise<void>) | null = null;

  afterAll(async () => {
    await stopService?.();
  });

  it("launching a nonexistent binary reaches the caller as a structured failure", async () => {
    const { runtime, attach } = makeRuntime();
    const service = (await ComputerUseService.start(
      runtime,
    )) as ComputerUseService;
    attach(service);
    stopService = () => service.stop();

    const handler = useComputerAction.handler;
    if (!handler) throw new Error("COMPUTER_USE handler missing");

    // The spawn of MISSING_BINARY really fails (ENOENT) — the failing
    // dependency is the OS itself, not a mock.
    const result = await handler(runtime, message, undefined, undefined);

    expect(result?.success).toBe(false);
    expect(typeof result?.error === "string" ? result.error : "").not.toBe("");
    // The old fabricated-success shape must never come back.
    expect(result?.data).toMatchObject({
      source: "computeruse",
      computerUseAction: "launch",
    });
  });
});
