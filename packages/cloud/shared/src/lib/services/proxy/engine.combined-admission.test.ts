/**
 * Proves the generic RPC proxy consumes one pre-resolved standing/admission
 * snapshot, marks immediately before provider dispatch, and retains settlement
 * asynchronously without a second auth or balance-cache read.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as authActual from "../../auth";
import * as creditsActual from "../credits";
import * as admissionActual from "../organization-inference-admission";
import type { ServiceConfig } from "./types";

const realAuth = { ...authActual };
const realAdmission = { ...admissionActual };
const legacyAuth = mock(async () => {
  throw new Error("legacy auth must not run");
});
const admit = mock<typeof admissionActual.admitOrganizationInference>();

mock.module("../../auth", () => ({
  ...realAuth,
  requireAuth: legacyAuth,
  requireAuthOrApiKey: legacyAuth,
  requireAuthOrApiKeyWithOrg: legacyAuth,
  requireAuthWithOrg: legacyAuth,
}));
mock.module("../organization-inference-admission", () => ({
  ...realAdmission,
  admitOrganizationInference: admit,
}));

const { createHandler } = await import("./engine");

const config: ServiceConfig = {
  id: "evm-rpc",
  name: "EVM RPC",
  auth: "apiKeyWithOrg",
  getCost: async () => 0.25,
};
const snapshot = {
  balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: "7" },
  rateLimits: {
    completionsRpm: 10,
    embeddingsRpm: 10,
    standardRpm: 10,
    strictRpm: 10,
  },
};

beforeEach(() => {
  legacyAuth.mockClear();
  admit.mockReset();
});

afterAll(() => {
  mock.module("../../auth", () => realAuth);
  mock.module("../organization-inference-admission", () => realAdmission);
});

test("combined RPC admission orders mark before dispatch and defers settlement", async () => {
  const order: string[] = [];
  let finishSettlement: (() => void) | undefined;
  const settlement = new Promise<void>((resolve) => {
    finishSettlement = resolve;
  });
  const settle = mock(async () => {
    order.push("settle");
    await settlement;
    return null;
  });
  admit.mockResolvedValue({
    mode: "durable_object_debit",
    markProviderDispatched: async () => {
      order.push("mark");
    },
    settle,
    settleUnknown: settle,
  });
  const retained: Promise<unknown>[] = [];
  const work = mock(async () => {
    order.push("dispatch");
    return { response: Response.json({ ok: true }) };
  });
  const handler = createHandler(config, work, {
    auth: {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: { id: "key-1" },
    },
    admissionSnapshot: snapshot,
    executionCtx: { waitUntil: (promise) => retained.push(promise) },
    requestId: "rpc-1",
  });

  const response = await handler(
    new Request("https://api.test/api/v1/rpc/ethereum", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    }),
  );

  expect(response.status).toBe(200);
  expect(order).toEqual(["mark", "dispatch", "settle"]);
  expect(legacyAuth).not.toHaveBeenCalled();
  expect(admit).toHaveBeenCalledTimes(1);
  expect(admit.mock.calls[0]?.[0].admissionSnapshot).toBe(snapshot);
  expect(retained).toHaveLength(1);
  finishSettlement?.();
  await Promise.all(retained);
});

test("combined RPC admission denial performs zero provider dispatch", async () => {
  admit.mockRejectedValueOnce(new creditsActual.InsufficientCreditsError(0.25, 0));
  const work = mock(async () => ({ response: new Response("not reached") }));
  const handler = createHandler(config, work, {
    auth: { user: { id: "user-1", organization_id: "org-1" } },
    admissionSnapshot: snapshot,
    executionCtx: { waitUntil: () => undefined },
    requestId: "rpc-denied",
  });

  const response = await handler(
    new Request("https://api.test/api/v1/rpc/ethereum", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
    }),
  );

  expect(response.status).toBe(402);
  expect(work).not.toHaveBeenCalled();
  expect(legacyAuth).not.toHaveBeenCalled();
});
