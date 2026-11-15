/**
 * The first-party mobile key surface of the SDK over real loopback HTTP: the
 * mobile checkout variant, the confirmation's entitlement and key renewal. The
 * server is a stand-in that records requests; no Cloud or provider is called.
 */
import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";
import { CloudApiError } from "./http.js";
import type {
  MobileCredentialRenewalRefusalCode,
  MobileCredentialRenewalRequest,
} from "./types.cloud-api.js";

const MOBILE_KEY = `eliza_mobile_${"a".repeat(64)}`;

interface Recorded {
  path: string;
  method: string;
  authorization: string | null;
  apiKey: string | null;
  body: unknown;
}

async function withServer(
  answer: (request: Recorded) => Response,
  run: (client: ElizaCloudClient, requests: Recorded[]) => Promise<void>,
) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const recorded = {
        path: new URL(request.url).pathname,
        method: request.method,
        authorization: request.headers.get("authorization"),
        apiKey: request.headers.get("x-api-key"),
        body: await request.json(),
      };
      requests.push(recorded);
      return answer(recorded);
    },
  });
  try {
    await run(
      new ElizaCloudClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: MOBILE_KEY,
      }),
      requests,
    );
  } finally {
    await server.stop(true);
  }
}

test("a mobile key starts a mobile checkout and confirms it with the returned session", async () => {
  await withServer(
    (request) =>
      request.path.endsWith("/confirm")
        ? Response.json({
            success: true,
            data: { subscriptionId: "sub_fixture", replayed: false },
            entitlement: {
              plan: { id: "plus_monthly", name: "Plus", status: "active" },
              source: "subscription",
              effectiveUntil: "2026-12-01T00:00:00.000Z",
            },
          })
        : Response.json({
            success: true,
            data: {
              status: "open",
              presentation: "mobile",
              commandId: "8a0f6c3e-7a9f-4f0e-9d53-0a5a7a1d2c11",
              checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture",
              sessionId: "cs_test_fixture",
              expiresAt: "2026-11-12T00:00:00.000Z",
            },
          }),
    async (client, requests) => {
      const input = {
        planKey: "plus_monthly" as const,
        idempotencyKey: "0d0f3c61-6f1b-4e59-9a55-0c6f6f4b2a10",
        presentation: "mobile" as const,
      };
      const started = await client.startSubscriptionCheckout(input);
      // The typed result carries the session the confirmation needs.
      if (
        started.data.status !== "open" ||
        !("presentation" in started.data) ||
        started.data.presentation !== "mobile"
      ) {
        throw new Error("expected an open mobile checkout");
      }
      const confirmed = await client.confirmSubscriptionCheckout(
        started.data.sessionId,
      );
      expect(confirmed.data).toEqual({
        subscriptionId: "sub_fixture",
        replayed: false,
      });
      expect(confirmed.entitlement?.plan.status).toBe("active");
      expect(confirmed.entitlement?.effectiveUntil).toBe(
        "2026-12-01T00:00:00.000Z",
      );
      expect(requests.map(({ path, body }) => ({ path, body }))).toEqual([
        { path: "/api/v1/subscriptions/checkout", body: input },
        {
          path: "/api/v1/subscriptions/checkout/confirm",
          body: { sessionId: "cs_test_fixture" },
        },
      ]);
    },
  );
});

test("key renewal posts the binding with the configured key and surfaces refusal codes", async () => {
  const binding: MobileCredentialRenewalRequest = {
    clientId: "ai.example.phone",
    environment: "production",
    redirectUri: "https://example.test/phone/auth/callback",
    state: "s".repeat(43),
    codeChallenge: "c".repeat(43),
    codeChallengeMethod: "S256",
    deviceName: "Fixture phone",
  };
  let refusal: {
    status: number;
    code: MobileCredentialRenewalRefusalCode;
  } | null = null;
  await withServer(
    () =>
      refusal
        ? Response.json(
            { success: false, error: "Refused", code: refusal.code },
            { status: refusal.status },
          )
        : Response.json({
            success: true,
            code: `emac_${"b".repeat(64)}`,
            codeType: "mobile_app_auth_code",
            expiresAt: "2026-11-11T00:05:00.000Z",
            expiresIn: 300,
          }),
    async (client, requests) => {
      const issued = await client.renewMobileCredential(binding);
      expect(issued.code).toBe(`emac_${"b".repeat(64)}`);
      expect(issued.expiresIn).toBe(300);
      // The client presents one key; when it sends both headers they agree,
      // which is what the renew and self-revoke routes accept.
      expect(requests).toEqual([
        {
          path: "/api/v1/app-auth/mobile/renew",
          method: "POST",
          authorization: `Bearer ${MOBILE_KEY}`,
          apiKey: MOBILE_KEY,
          body: binding,
        },
      ]);

      for (const next of [
        { status: 409, code: "renewal_window_closed" },
        { status: 401, code: "authentication_required" },
      ] as const) {
        refusal = next;
        const error = await client
          .renewMobileCredential(binding)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CloudApiError);
        expect((error as CloudApiError).statusCode).toBe(next.status);
        expect((error as CloudApiError).errorBody.code).toBe(next.code);
      }
    },
  );
});
