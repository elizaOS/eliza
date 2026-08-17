/**
 * Exercises the storage presign route through its real Hono boundary with
 * deterministic authentication, billing, and storage collaborators. The suite
 * protects the GET-only contract and verifies that rejected requests cannot
 * initialize storage or create billing and provider side effects.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { Hono } from "hono";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000021009";
const FIXED_NOW = new Date("2026-08-17T12:00:00.000Z");
const COST = 0.00005;
const SIGNED_URL = "https://r2.example.test/signed-object";
const ROUTE_PATH = "/api/v1/apis/storage/presign";

const requireUserOrApiKeyWithOrg = mock();
const getR2StorageAdapter = mock();
const getServiceMethodCost = mock();
const deductCredits = mock();
const presignGet = mock();
const failureResponse = mock();
const loggerError = mock();

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/storage/r2-storage-adapter", () => ({
  getR2StorageAdapter,
}));

mock.module("@/lib/services/proxy/pricing", () => ({
  getServiceMethodCost,
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: { deductCredits },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError },
}));

const presignRoute = (await import("../v1/apis/storage/presign/route")).default;
const app = new Hono();
app.route(ROUTE_PATH, presignRoute);

function post(body: unknown): Response | Promise<Response> {
  return app.request(ROUTE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setSystemTime(FIXED_NOW);
  requireUserOrApiKeyWithOrg.mockReset();
  getR2StorageAdapter.mockReset();
  getServiceMethodCost.mockReset();
  deductCredits.mockReset();
  presignGet.mockReset();
  failureResponse.mockReset();
  loggerError.mockReset();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: ORGANIZATION_ID,
  });
  getR2StorageAdapter.mockReturnValue({ presignGet });
  getServiceMethodCost.mockResolvedValue(COST);
  deductCredits.mockResolvedValue({ success: true });
  presignGet.mockResolvedValue(SIGNED_URL);
});

afterEach(() => {
  setSystemTime();
});

describe("POST /api/v1/apis/storage/presign", () => {
  test("rejects PUT after authentication and before storage or billing side effects", async () => {
    const response = await post({
      key: "voice/message.ogg",
      operation: "put",
      expiresIn: 600,
    });

    expect(response.status).toBe(400);
    const responseBody: unknown = await response.json();
    expect(responseBody).toMatchObject({
      error: "Invalid presign request",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(getR2StorageAdapter).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(presignGet).not.toHaveBeenCalled();
  });

  test("presigns GET with the scoped key, explicit TTL, and exact debit metadata", async () => {
    const response = await post({
      key: "/voice/message.ogg/",
      operation: "get",
      expiresIn: 600,
    });

    expect(response.status).toBe(200);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T12:10:00.000Z",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(getR2StorageAdapter).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "presign");
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      amount: COST,
      description: "API proxy: storage — presign (get)",
      metadata: {
        type: "proxy_storage",
        service: "storage",
        method: "presign",
        operation: "get",
      },
    });
    expect(presignGet).toHaveBeenCalledTimes(1);
    expect(presignGet).toHaveBeenCalledWith(
      `org/${ORGANIZATION_ID}/voice/message.ogg`,
      600,
    );
  });

  test("uses the one-hour default TTL without charging when the catalog cost is zero", async () => {
    getServiceMethodCost.mockResolvedValueOnce(0);

    const response = await post({
      key: "avatars/profile.png",
      operation: "get",
    });

    expect(response.status).toBe(200);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T13:00:00.000Z",
    });
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "presign");
    expect(deductCredits).not.toHaveBeenCalled();
    expect(presignGet).toHaveBeenCalledWith(
      `org/${ORGANIZATION_ID}/avatars/profile.png`,
      3600,
    );
  });

  test("does not presign when the organization has insufficient credits", async () => {
    deductCredits.mockResolvedValueOnce({ success: false });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
      expiresIn: 300,
    });

    expect(response.status).toBe(402);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      error: "Insufficient credits",
      topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
    });
    expect(getR2StorageAdapter).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(presignGet).not.toHaveBeenCalled();
  });

  test("rejects traversal keys before storage initialization or billing", async () => {
    const response = await post({
      key: "voice/../secret.txt",
      operation: "get",
    });

    expect(response.status).toBe(400);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({ error: "Invalid object key" });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(getR2StorageAdapter).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(presignGet).not.toHaveBeenCalled();
  });
});
