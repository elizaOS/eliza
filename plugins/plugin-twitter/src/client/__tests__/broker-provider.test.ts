import { describe, it, expect, vi } from "vitest";
import { BrokerAuthProvider } from "../auth-providers/broker";

describe("BrokerAuthProvider", () => {
  it("throws if TWITTER_BROKER_URL is missing", async () => {
    const runtime: any = {
      getSetting: vi.fn(() => undefined),
    };

    const provider = new BrokerAuthProvider(runtime);
    await expect(provider.getAccessToken()).rejects.toThrow(
      "TWITTER_AUTH_MODE=broker requires TWITTER_BROKER_URL",
    );
  });
});

