import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BrokerAuthProvider } from "../auth-providers/broker";

describe("BrokerAuthProvider", () => {
  it("throws if X_BROKER_URL is missing", async () => {
    const runtime: Partial<IAgentRuntime> = {
      getSetting: vi.fn(() => undefined),
    };

    const provider = new BrokerAuthProvider(runtime);
    await expect(provider.getAccessToken()).rejects.toThrow(
      "X_AUTH_MODE=broker requires X_BROKER_URL"
    );
  });
});
