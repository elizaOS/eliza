import { afterEach, describe, expect, it } from "vitest";
import { ElizaClient } from "../client-base";
import "../client-cloud";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createCloudBillingCheckout", () => {
  it("sends one idempotency key that the client retry loop can reuse", async () => {
    const requests: RequestInit[] = [];
    const client = new ElizaClient("https://cloud.example");
    client.setRequestTransport({
      request: async (_url, init) => {
        requests.push(init);
        if (requests.length === 1) {
          return new Response(JSON.stringify({ status: "starting" }), {
            status: 202,
            headers: { "Retry-After": "0" },
          });
        }
        return new Response(
          JSON.stringify({
            checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
            sessionId: "cs_test_1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await client.createCloudBillingCheckout({ amountUsd: 5 });

    expect(requests).toHaveLength(2);
    const idempotencyKey = new Headers(requests[0].headers).get(
      "Idempotency-Key",
    );
    expect(idempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    expect(new Headers(requests[1].headers).get("Idempotency-Key")).toBe(
      idempotencyKey,
    );
  });
});
