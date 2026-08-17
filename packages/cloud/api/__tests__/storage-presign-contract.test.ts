/**
 * Exercises the storage signed-read route through its real Hono boundary with
 * deterministic authentication, native R2, capability, and billing seams. The
 * suite proves that configuration, object, pricing, and signing failures occur
 * before the credit debit and that an undisclosed capability is never returned
 * after a debit rejection.
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

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000021045";
const FIXED_NOW = new Date("2026-08-17T12:00:00.000Z");
const COST = 0.00005;
const SIGNED_URL =
  "https://blob-staging.eliza.app/_storage/read/v1.payload.signature";
const ROUTE_PATH = "/api/v1/apis/storage/presign";
const SIGNING_SECRETS =
  "0123456789abcdef0123456789abcdef,abcdef0123456789abcdef0123456789";

class TestStorageReadCapabilityConfigurationError extends Error {}

const events: string[] = [];
const requireUserOrApiKeyWithOrg = mock();
const getServiceMethodCost = mock();
const deductCredits = mock();
const mintStorageReadCapabilityUrl = mock();
const normalizeStorageReadCapabilityHost = mock();
const r2Head = mock();
const failureResponse = mock();
const loggerError = mock();

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/api-app/storage-read-capability", () => ({
  mintStorageReadCapabilityUrl,
  normalizeStorageReadCapabilityHost,
  StorageReadCapabilityConfigurationError:
    TestStorageReadCapabilityConfigurationError,
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

function makeEnv(
  blob: Record<string, unknown> = { head: r2Head },
): Record<string, unknown> {
  return {
    BLOB: blob,
    R2_PUBLIC_HOST: "blob-staging.eliza.app",
    STORAGE_READ_SIGNING_SECRETS: SIGNING_SECRETS,
  };
}

async function post(
  body: unknown,
  env: Record<string, unknown> = makeEnv(),
): Promise<Response> {
  return await app.request(
    ROUTE_PATH,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function readJson(response: Response): Promise<unknown> {
  return await response.json();
}

beforeEach(() => {
  setSystemTime(FIXED_NOW);
  events.length = 0;
  requireUserOrApiKeyWithOrg.mockReset();
  getServiceMethodCost.mockReset();
  deductCredits.mockReset();
  mintStorageReadCapabilityUrl.mockReset();
  normalizeStorageReadCapabilityHost.mockReset();
  r2Head.mockReset();
  failureResponse.mockReset();
  loggerError.mockReset();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: ORGANIZATION_ID,
  });
  r2Head.mockImplementation(async () => {
    events.push("head");
    return { size: 123 };
  });
  getServiceMethodCost.mockImplementation(async () => {
    events.push("price");
    return COST;
  });
  mintStorageReadCapabilityUrl.mockImplementation(async () => {
    events.push("mint");
    return SIGNED_URL;
  });
  normalizeStorageReadCapabilityHost.mockImplementation((host: string) =>
    host.trim().toLowerCase(),
  );
  deductCredits.mockImplementation(async () => {
    events.push("debit");
    return { success: true };
  });
  failureResponse.mockReturnValue(
    Response.json(
      {
        success: false,
        error: "An unexpected error occurred",
        code: "internal_error",
      },
      { status: 500 },
    ),
  );
});

afterEach(() => {
  setSystemTime();
});

describe("POST /api/v1/apis/storage/presign", () => {
  test("rejects PUT after authentication and before R2, capability, or billing work", async () => {
    const response = await post({
      key: "voice/message.ogg",
      operation: "put",
      expiresIn: 600,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid presign request",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("mints the exact scoped GET capability before the debit and returns it afterward", async () => {
    const response = await post({
      key: "/voice/message.ogg/",
      operation: "get",
      expiresIn: 600,
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T12:10:00.000Z",
    });
    expect(r2Head).toHaveBeenCalledWith(
      `org/${ORGANIZATION_ID}/voice/message.ogg`,
    );
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "presign");
    expect(mintStorageReadCapabilityUrl).toHaveBeenCalledWith({
      rawSecrets: SIGNING_SECRETS,
      host: "blob-staging.eliza.app",
      scopedKey: `org/${ORGANIZATION_ID}/voice/message.ogg`,
      issuedAt: 1_786_968_000,
      expiresAt: 1_786_968_600,
    });
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
    expect(events).toEqual(["head", "price", "mint", "debit"]);
  });

  test("uses the one-hour default TTL without debiting when catalog cost is zero", async () => {
    getServiceMethodCost.mockImplementationOnce(async () => {
      events.push("price");
      return 0;
    });

    const response = await post({
      key: "avatars/profile.png",
      operation: "get",
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T13:00:00.000Z",
    });
    expect(mintStorageReadCapabilityUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        issuedAt: 1_786_968_000,
        expiresAt: 1_786_971_600,
      }),
    );
    expect(deductCredits).not.toHaveBeenCalled();
    expect(events).toEqual(["head", "price", "mint"]);
  });

  test("accepts the largest user key whose tenant-scoped UTF-8 key is 1024 bytes", async () => {
    const userKey = "a".repeat(983);

    const response = await post({ key: userKey, operation: "get" });

    expect(response.status).toBe(200);
    expect(r2Head).toHaveBeenCalledWith(`org/${ORGANIZATION_ID}/${userKey}`);
    expect(mintStorageReadCapabilityUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        scopedKey: `org/${ORGANIZATION_ID}/${userKey}`,
      }),
    );
    expect(events).toEqual(["head", "price", "mint", "debit"]);
  });

  test("rejects a user key that makes the tenant-scoped UTF-8 key exceed 1024 bytes", async () => {
    const response = await post({
      key: "a".repeat(984),
      operation: "get",
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ error: "Invalid object key" });
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("returns 402 without disclosing the minted capability when debit is declined", async () => {
    deductCredits.mockImplementationOnce(async () => {
      events.push("debit");
      return { success: false };
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
      expiresIn: 300,
    });

    expect(response.status).toBe(402);
    const bodyText = await response.text();
    expect(JSON.parse(bodyText)).toEqual({
      error: "Insufficient credits",
      topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
    });
    expect(bodyText).not.toContain(SIGNED_URL);
    expect(events).toEqual(["head", "price", "mint", "debit"]);
  });

  test("returns 404 for a missing object before pricing, minting, or debit", async () => {
    r2Head.mockImplementationOnce(async () => {
      events.push("head");
      return null;
    });

    const response = await post({
      key: "voice/missing.ogg",
      operation: "get",
    });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ error: "Object not found" });
    expect(events).toEqual(["head"]);
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("fails closed when the runtime binding lacks native HEAD support", async () => {
    const response = await post(
      { key: "voice/message.ogg", operation: "get" },
      makeEnv({ get: mock() }),
    );

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      error: "Attachment storage proxy not available — server misconfigured",
    });
    expect(events).toEqual([]);
    expect(loggerError).toHaveBeenCalledWith(
      "[storage proxy] Native R2 HEAD capability unavailable; signed read rejected",
    );
  });

  test("rejects a missing or blank private blob host before R2 or billing work", async () => {
    for (const configuredHost of [undefined, "   "] as const) {
      const env = makeEnv();
      if (configuredHost === undefined) delete env.R2_PUBLIC_HOST;
      else env.R2_PUBLIC_HOST = configuredHost;

      const response = await post(
        { key: "voice/message.ogg", operation: "get" },
        env,
      );

      expect(response.status).toBe(503);
      expect(await readJson(response)).toEqual({
        error: "Attachment storage proxy not available — server misconfigured",
      });
    }
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(loggerError).toHaveBeenLastCalledWith(
      "[storage proxy] Signed read capability configuration unavailable",
    );
  });

  test("maps invalid signing configuration to 503 before debit without logging details", async () => {
    mintStorageReadCapabilityUrl.mockImplementationOnce(async () => {
      events.push("mint");
      throw new TestStorageReadCapabilityConfigurationError("secret sentinel");
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(responseText).not.toContain("secret sentinel");
    expect(events).toEqual(["head", "price", "mint"]);
    expect(deductCredits).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[storage proxy] Signed read capability configuration unavailable",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "secret sentinel",
    );
  });

  test("does not debit when capability generation fails unexpectedly", async () => {
    mintStorageReadCapabilityUrl.mockImplementationOnce(async () => {
      events.push("mint");
      throw new Error("signer failed");
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(500);
    expect(events).toEqual(["head", "price", "mint"]);
    expect(deductCredits).not.toHaveBeenCalled();
    expect(failureResponse).toHaveBeenCalledTimes(1);
  });

  test("does not mint or debit when pricing fails", async () => {
    getServiceMethodCost.mockImplementationOnce(async () => {
      events.push("price");
      throw new Error("pricing unavailable");
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(500);
    expect(events).toEqual(["head", "price"]);
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  test("rejects unsafe or byte-oversized keys before R2, capability, or billing work", async () => {
    for (const key of [
      "voice/../secret.txt",
      "voice/./message.ogg",
      "voice//message.ogg",
      "voice/\u0000message.ogg",
      `voice/${"é".repeat(600)}.ogg`,
    ]) {
      const response = await post({ key, operation: "get" });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({ error: "Invalid object key" });
    }

    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });
});
