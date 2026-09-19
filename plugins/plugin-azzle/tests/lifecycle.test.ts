import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createAzzleLifecycleAction } from "../src/actions/lifecycle.js";

const runtime = {
  getSetting: vi.fn(() => "https://base.example"),
} as unknown as IAgentRuntime;
const message = { content: { source: "test" } } as Memory;

describe("AZZLE lifecycle actions", () => {
  it("passes AZL wei through to the injected Base client", async () => {
    const client = {
      fund: vi.fn(async () => "0xhash"),
    };
    const action = createAzzleLifecycleAction("fund", () => client as never);
    const result = await action.handler(runtime, message, undefined, {
      parameters: {
        taskId: "v2:micro:3",
        amountAzlWei: "1000000000000000000",
      },
    });

    expect(client.fund).toHaveBeenCalledWith("v2:micro:3", "1000000000000000000");
    expect(result).toMatchObject({ success: true, data: { transactionHash: "0xhash", operation: "fund" } });
  });

  it("requires a configured Base RPC URL", async () => {
    const action = createAzzleLifecycleAction("claim", () => ({}) as never);
    expect(await action.validate({ getSetting: () => undefined } as unknown as IAgentRuntime, message)).toBe(false);
  });
});
