import { describe, expect, test } from "bun:test";
import { createTopupHandler } from "@/lib/services/topup-handler";

const recipient = "0x000000000000000000000000000000000000dEaD";
const walletAddress = "0x1111111111111111111111111111111111111111";

describe("topup handler", () => {
  test("returns an x402 quote instead of a Worker stub when payment is missing", async () => {
    const handler = createTopupHandler({
      amount: 10,
      getSourceId: (_wallet, paymentId) => `test:${paymentId}`,
    });

    const response = await handler(
      new Request("https://api.example.test/api/v1/topup/10", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress }),
      }),
      {
        X402_RECIPIENT_ADDRESS: recipient,
        X402_NETWORK: "base-sepolia",
      },
    );

    expect(response.status).toBe(402);
    expect(response.headers.get("X-PAYMENT-STATUS")).toBe("required");

    const body = (await response.json()) as {
      x402Version: number;
      accepts: Array<{ amount: string; maxAmountRequired: string; network: string; payTo: string }>;
    };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0].amount).toBe("10000000");
    expect(body.accepts[0].maxAmountRequired).toBe("10000000");
    expect(body.accepts[0].network).toBe("eip155:84532");
    expect(body.accepts[0].payTo).toBe(recipient);
  });

  test("rejects invalid recipient wallet addresses before payment handling", async () => {
    const handler = createTopupHandler({
      amount: 50,
      getSourceId: (_wallet, paymentId) => `test:${paymentId}`,
    });

    const response = await handler(
      new Request("https://api.example.test/api/v1/topup/50", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddress: "not-a-wallet" }),
      }),
      { X402_RECIPIENT_ADDRESS: recipient },
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toEqual({
      error: "Valid EVM walletAddress is required",
    });
  });
});
