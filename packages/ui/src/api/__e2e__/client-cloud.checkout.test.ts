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

  it("creates checkout on the control plane for a Shared agent base", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({
          url: "https://checkout.stripe.com/c/pay/cs_test_2",
          sessionId: "cs_test_2",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const client = new ElizaClient(
      "https://api.eliza.app/api/v1/eliza/agents/personal:11111111-1111-5111-8111-111111111111",
      "cloud-session-token",
    );

    const response = await client.createCloudBillingCheckout({ amountUsd: 5 });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://api.eliza.app/api/v1/credits/checkout",
    );
    const headers = new Headers(requests[0].init.headers);
    expect(headers.get("Authorization")).toBe("Bearer cloud-session-token");
    expect(headers.get("Idempotency-Key")).toMatch(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/,
    );
    expect(JSON.parse(String(requests[0].init.body))).toEqual({
      amountUsd: 5,
      success_url: "https://cloud.eliza.app/cloud/billing/success?from=eliza",
      cancel_url:
        "https://cloud.eliza.app/cloud/billing?from=eliza&tab=billing&canceled=1",
    });
    expect(response).toEqual({
      success: true,
      provider: "stripe",
      mode: "hosted",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_2",
      sessionId: "cs_test_2",
    });
  });
});
