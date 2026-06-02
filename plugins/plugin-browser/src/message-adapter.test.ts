import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BrowserBridgeAdapter } from "./message-adapter.js";

describe("BrowserBridgeAdapter", () => {
  it("declares the browser bridge triage placeholder as unavailable", async () => {
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn(),
    } as unknown as IAgentRuntime;
    const adapter = new BrowserBridgeAdapter();

    expect(adapter.source).toBe("browser_bridge");
    expect(adapter.isAvailable(runtime)).toBe(false);
    expect(adapter.capabilities()).toMatchObject({
      list: false,
      search: false,
      channels: "implicit",
    });
    await expect(adapter.listMessages(runtime, { limit: 5 })).resolves.toEqual(
      [],
    );
  });
});
