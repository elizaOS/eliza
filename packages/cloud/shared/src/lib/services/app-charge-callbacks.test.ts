/**
 * SSRF-guard contract for app-charge callback delivery: the HTTP callback POST
 * must go through the IP-screening `safeFetch` (never a raw fetch), and a guard
 * rejection must surface as a recorded dispatch error — not a thrown exception
 * (the charge leg is already settled; only the notification fails). DB reads
 * and the safeFetch transport are mocked; the real dispatch logic runs.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const CALLBACK_URL = "https://developer.example.com/hooks/app-charge";
const CHARGE_ID = "charge-123";
const APP_ID = "app-456";

let chargeRow: Record<string, unknown> | undefined;
const safeFetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let safeFetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

mock.module("../../db/helpers", () => ({
  dbRead: {
    query: {
      cryptoPayments: {
        findFirst: async () => chargeRow,
      },
    },
  },
  dbWrite: {},
  writeTransaction: async () => {
    throw new Error("transaction is outside this callback test path");
  },
}));

mock.module("../../db/repositories/agents/memories", () => ({
  memoriesRepository: { create: async () => ({}) },
}));

mock.module("./callback-channel-authz", () => ({
  callbackRoomBelongsToOrganization: async () => false,
}));

mock.module("../security/safe-fetch", () => ({
  safeFetch: (url: string, init?: RequestInit) => {
    safeFetchCalls.push({ url, init });
    return safeFetchImpl(url, init);
  },
}));

mock.module("../utils/logger", () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  redact: { id: (v: string) => v, orgId: (v: string) => v, userId: (v: string) => v },
}));

const { appChargeCallbacksService } = await import("./app-charge-callbacks");

function seedCharge(metadata: Record<string, unknown>): void {
  chargeRow = {
    id: CHARGE_ID,
    organization_id: "org-1",
    expected_amount: "12.50",
    metadata,
  };
}

const DISPATCH_PARAMS = {
  appId: APP_ID,
  chargeRequestId: CHARGE_ID,
  status: "paid" as const,
  provider: "stripe" as const,
  providerPaymentId: "pi_123",
  amountUsd: "12.500000000000000001",
};

describe("AppChargeCallbacksService — SSRF-guarded HTTP callback", () => {
  beforeEach(() => {
    chargeRow = undefined;
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => new Response("ok", { status: 200 });
  });

  it("delivers the callback POST through safeFetch with the signed headers", async () => {
    seedCharge({
      kind: "app_charge_request",
      app_id: APP_ID,
      callback_url: CALLBACK_URL,
      callback_secret: "whsec_test",
    });

    const result = await appChargeCallbacksService.dispatch(DISPATCH_PARAMS);

    expect(result.httpPosted).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(safeFetchCalls).toHaveLength(1);
    const call = safeFetchCalls[0];
    expect(call.url).toBe(CALLBACK_URL);
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Eliza-Event"]).toBe("app_charge.paid");
    expect(headers["X-Eliza-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(String(call.init?.body)) as {
      charge: { amountUsd: string };
      payment: { amountUsd: string };
    };
    expect(body.charge.amountUsd).toBe("12.500000000000000001");
    expect(body.payment.amountUsd).toBe("12.500000000000000001");
  });

  it("records a guard rejection as a dispatch error instead of throwing", async () => {
    seedCharge({
      kind: "app_charge_request",
      app_id: APP_ID,
      callback_url: CALLBACK_URL,
    });
    safeFetchImpl = async () => {
      throw new Error("Private or reserved IP addresses are not allowed");
    };

    const result = await appChargeCallbacksService.dispatch(DISPATCH_PARAMS);

    expect(result.httpPosted).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Private or reserved IP");
  });

  it("returns a non-OK callback status as a recorded error", async () => {
    seedCharge({
      kind: "app_charge_request",
      app_id: APP_ID,
      callback_url: CALLBACK_URL,
    });
    safeFetchImpl = async () => new Response("nope", { status: 500 });

    const result = await appChargeCallbacksService.dispatch(DISPATCH_PARAMS);

    expect(result.httpPosted).toBe(false);
    expect(result.errors[0]).toContain("500");
  });

  it("retries with an immutable callback envelope", async () => {
    seedCharge({
      kind: "app_charge_request",
      app_id: APP_ID,
      callback_url: CALLBACK_URL,
    });

    await appChargeCallbacksService.dispatch(DISPATCH_PARAMS);
    await appChargeCallbacksService.dispatch(DISPATCH_PARAMS);

    expect(safeFetchCalls).toHaveLength(2);
    expect(String(safeFetchCalls[1]?.init?.body)).toBe(String(safeFetchCalls[0]?.init?.body));
  });
});
