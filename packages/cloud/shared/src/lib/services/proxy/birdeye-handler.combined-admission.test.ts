/**
 * Proves the canonical Birdeye route hands its single standing decision to the
 * proxy engine without invoking the legacy auth or direct-debit path.
 */

import { expect, mock, test } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";

const executeWithBody = mock(async () => Response.json({ ok: true }));
const legacyAuth = mock(async () => {
  throw new Error("legacy auth must not run");
});
const directDebit = mock(async () => {
  throw new Error("direct debit must not run");
});

mock.module("./engine", () => ({ executeWithBody }));
mock.module("../../auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: legacyAuth,
}));
mock.module("../credits", () => ({
  creditsService: { deductCredits: directDebit },
}));

const { handleBirdeyeMarketDataProxyGet } = await import("./birdeye-handler");

test("combined Birdeye handling forwards admission without legacy standing or debit", async () => {
  const request = new Request("https://api.test/api/v1/apis/birdeye/defi/price?address=token");
  const c = {
    req: {
      raw: request,
      url: request.url,
      param: (name: string) => (name === "*" ? "defi/price" : undefined),
      header: () => undefined,
    },
    env: { BIRDEYE_API_KEY: "configured" },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<AppEnv>;
  const admission = {
    mode: "combined" as const,
    auth: {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    },
    requestId: "birdeye-1",
    admissionSnapshot: {
      balance: {
        balanceUsd: 10,
        balanceAt: Date.now(),
        balanceRevision: "5",
      },
      rateLimits: {
        completionsRpm: 10,
        embeddingsRpm: 10,
        standardRpm: 10,
        strictRpm: 10,
      },
    },
    executionCtx: { waitUntil: () => undefined },
  };

  const response = await handleBirdeyeMarketDataProxyGet(c, admission);

  expect(response.status).toBe(200);
  expect(executeWithBody).toHaveBeenCalledTimes(1);
  expect(executeWithBody.mock.calls[0]?.[3]).toEqual({
    method: "getPrice",
    path: "defi/price",
  });
  expect(executeWithBody.mock.calls[0]?.[4]).toBe(admission);
  expect(legacyAuth).not.toHaveBeenCalled();
  expect(directDebit).not.toHaveBeenCalled();
});
