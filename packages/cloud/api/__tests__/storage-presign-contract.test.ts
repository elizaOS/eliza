/**
 * Exercises the storage signed-read route through its real Hono boundary with
 * deterministic authentication, native R2, capability, and durable receipt
 * seams. The mocked service models committed receipt recovery while assertions
 * prove effect ordering and prevent capability disclosure after failures.
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
const FIXED_NOW_SECONDS = 1_786_968_000;
const COST = 0.00005;
const IDEMPOTENCY_KEY = "storage-read-contract-test-21045";
const INVALID_IDEMPOTENCY_KEY = "x".repeat(129);
const TRANSACTION_ID = "00000000-0000-4000-8000-000000021100";
const SIGNED_URL =
  "https://blob-staging.eliza.app/_storage/read/v1.payload.signature";
const RACE_SIGNED_URL =
  "https://blob-staging.eliza.app/_storage/read/v1.race.signature";
const ROUTE_PATH = "/api/v1/apis/storage/presign";
const SIGNING_SECRETS =
  "0123456789abcdef0123456789abcdef,abcdef0123456789abcdef0123456789";

interface ReceiptTemporalClaims {
  issuedAt: number;
  expiresAt: number;
  capabilityHost: string;
}

interface ReceiptClaims extends ReceiptTemporalClaims {
  chargeAmountUsd: string;
}

interface PrepareInput {
  rawIdempotencyKey: string | undefined;
  organizationId: string;
  scopedKey: string;
  ttlSeconds: number;
  capabilityHost: string;
}

interface NewPreparedReceipt {
  status: "new";
  organizationId: string;
  ledgerIdempotencyKey: string;
  requestDigest: string;
  ttlSeconds: number;
  capabilityHost: string;
  candidateClaims: ReceiptTemporalClaims;
}

interface ReplayedPreparedReceipt {
  status: "replay";
  organizationId: string;
  ledgerIdempotencyKey: string;
  requestDigest: string;
  ttlSeconds: number;
  capabilityHost: string;
  claims: ReceiptClaims;
  transactionId: string;
}

class TestStorageReadCapabilityConfigurationError extends Error {}
class TestStorageReadReceiptInvalidIdempotencyKeyError extends Error {}
class TestStorageReadReceiptInsufficientCreditsError extends Error {}
class TestStorageReadReceiptUnavailableError extends Error {}
class TestStorageReadReceiptConflictError extends Error {
  readonly transactionId: string | undefined;

  constructor(
    readonly reason: "idempotency_key_reused" | "receipt_expired",
    expiredTransactionId?: string,
  ) {
    super(reason);
    this.transactionId =
      reason === "receipt_expired" ? expiredTransactionId : undefined;
  }
}

const events: string[] = [];
const requireUserOrApiKeyWithOrg = mock();
const getServiceMethodCost = mock();
const prepareReceipt = mock();
const chargeOrReplay = mock();
const mintStorageReadCapabilityUrl = mock();
const normalizeStorageReadCapabilityHost = mock();
const r2Head = mock();
const failureResponse = mock();
const jsonError = mock(
  (
    _context: unknown,
    status: number,
    message: string,
    code: string,
    details?: Record<string, unknown>,
  ) =>
    Response.json(
      { success: false, error: message, code, ...(details ? { details } : {}) },
      { status },
    ),
);
const loggerError = mock();

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse,
  jsonError,
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

mock.module("@/lib/services/storage-read-receipts", () => ({
  StorageReadReceiptConflictError: TestStorageReadReceiptConflictError,
  StorageReadReceiptInsufficientCreditsError:
    TestStorageReadReceiptInsufficientCreditsError,
  StorageReadReceiptInvalidIdempotencyKeyError:
    TestStorageReadReceiptInvalidIdempotencyKeyError,
  StorageReadReceiptUnavailableError: TestStorageReadReceiptUnavailableError,
  storageReadReceiptService: { prepare: prepareReceipt, chargeOrReplay },
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

function newPreparedReceipt(input: PrepareInput): NewPreparedReceipt {
  return {
    status: "new",
    organizationId: input.organizationId,
    ledgerIdempotencyKey: "storage-read:v1:test-digest",
    requestDigest: "request-digest",
    ttlSeconds: input.ttlSeconds,
    capabilityHost: input.capabilityHost,
    candidateClaims: {
      issuedAt: FIXED_NOW_SECONDS,
      expiresAt: FIXED_NOW_SECONDS + input.ttlSeconds,
      capabilityHost: input.capabilityHost,
    },
  };
}

function replayedReceipt(
  input: PrepareInput,
  claims: ReceiptClaims,
): ReplayedPreparedReceipt {
  return {
    status: "replay",
    organizationId: input.organizationId,
    ledgerIdempotencyKey: "storage-read:v1:test-digest",
    requestDigest: "request-digest",
    ttlSeconds: input.ttlSeconds,
    capabilityHost: input.capabilityHost,
    claims,
    transactionId: TRANSACTION_ID,
  };
}

async function post(
  body: unknown,
  env: Record<string, unknown> = makeEnv(),
  idempotencyKey: string | null = IDEMPOTENCY_KEY,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey !== null) {
    headers.set("Idempotency-Key", idempotencyKey);
  }
  return await app.request(
    ROUTE_PATH,
    {
      method: "POST",
      headers,
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
  prepareReceipt.mockReset();
  chargeOrReplay.mockReset();
  mintStorageReadCapabilityUrl.mockReset();
  normalizeStorageReadCapabilityHost.mockReset();
  r2Head.mockReset();
  failureResponse.mockReset();
  jsonError.mockClear();
  loggerError.mockReset();

  requireUserOrApiKeyWithOrg.mockResolvedValue({
    organization_id: ORGANIZATION_ID,
  });
  prepareReceipt.mockImplementation(async (input: PrepareInput) => {
    events.push("prepare");
    return newPreparedReceipt(input);
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
  chargeOrReplay.mockImplementation(
    async (
      prepared: NewPreparedReceipt,
      options: { chargeAmountUsd: number },
    ) => {
      events.push("charge");
      return {
        claims: {
          ...prepared.candidateClaims,
          chargeAmountUsd: String(options.chargeAmountUsd),
        },
        transactionId: TRANSACTION_ID,
        replayed: false,
      };
    },
  );
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
  test("rejects PUT after authentication and before receipt, R2, capability, or pricing work", async () => {
    const response = await post({
      key: "voice/message.ogg",
      operation: "put",
      expiresIn: 600,
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      error: "Invalid presign request",
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
    expect(prepareReceipt).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("maps a missing idempotency header to validation_error before R2", async () => {
    prepareReceipt.mockImplementationOnce(async (input: PrepareInput) => {
      events.push("prepare");
      expect(input.rawIdempotencyKey).toBeUndefined();
      throw new TestStorageReadReceiptInvalidIdempotencyKeyError();
    });

    const response = await post(
      { key: "voice/message.ogg", operation: "get" },
      makeEnv(),
      null,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      success: false,
      error: "A valid Idempotency-Key header is required",
      code: "validation_error",
    });
    expect(events).toEqual(["prepare"]);
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("maps an invalid idempotency header to validation_error before R2", async () => {
    prepareReceipt.mockImplementationOnce(async (input: PrepareInput) => {
      events.push("prepare");
      expect(input.rawIdempotencyKey).toBe(INVALID_IDEMPOTENCY_KEY);
      throw new TestStorageReadReceiptInvalidIdempotencyKeyError();
    });

    const response = await post(
      { key: "voice/message.ogg", operation: "get" },
      makeEnv(),
      INVALID_IDEMPOTENCY_KEY,
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      code: "validation_error",
    });
    expect(events).toEqual(["prepare"]);
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("mints before charging and returns the committed receipt", async () => {
    const response = await post({
      key: "/voice/message.ogg/",
      operation: "get",
      expiresIn: 600,
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T12:10:00.000Z",
      receiptId: TRANSACTION_ID,
    });
    expect(prepareReceipt).toHaveBeenCalledWith({
      rawIdempotencyKey: IDEMPOTENCY_KEY,
      organizationId: ORGANIZATION_ID,
      scopedKey: `org/${ORGANIZATION_ID}/voice/message.ogg`,
      ttlSeconds: 600,
      capabilityHost: "blob-staging.eliza.app",
    });
    expect(r2Head).toHaveBeenCalledWith(
      `org/${ORGANIZATION_ID}/voice/message.ogg`,
    );
    expect(getServiceMethodCost).toHaveBeenCalledWith("storage", "presign");
    expect(mintStorageReadCapabilityUrl).toHaveBeenCalledWith({
      rawSecrets: SIGNING_SECRETS,
      host: "blob-staging.eliza.app",
      scopedKey: `org/${ORGANIZATION_ID}/voice/message.ogg`,
      issuedAt: FIXED_NOW_SECONDS,
      expiresAt: FIXED_NOW_SECONDS + 600,
    });
    expect(chargeOrReplay).toHaveBeenCalledWith(
      expect.objectContaining({ status: "new" }),
      { chargeAmountUsd: COST },
    );
    expect(events).toEqual(["prepare", "head", "price", "mint", "charge"]);
  });

  test("replays durable claims without R2, pricing, or another charge", async () => {
    const durableClaims: ReceiptClaims = {
      issuedAt: FIXED_NOW_SECONDS - 60,
      expiresAt: FIXED_NOW_SECONDS + 240,
      capabilityHost: "blob-staging.eliza.app",
      chargeAmountUsd: String(COST),
    };
    prepareReceipt.mockImplementationOnce(async (input: PrepareInput) => {
      events.push("prepare");
      return replayedReceipt(input, durableClaims);
    });

    const response = await post(
      {
        key: "voice/message.ogg",
        operation: "get",
        expiresIn: 300,
      },
      makeEnv({ get: mock() }),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T12:04:00.000Z",
      receiptId: TRANSACTION_ID,
    });
    expect(mintStorageReadCapabilityUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        issuedAt: FIXED_NOW_SECONDS - 60,
        expiresAt: FIXED_NOW_SECONDS + 240,
      }),
    );
    expect(events).toEqual(["prepare", "mint"]);
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("recovers a committed receipt after acknowledgement loss without charging twice", async () => {
    let committedReceipt: ReplayedPreparedReceipt | undefined;
    prepareReceipt.mockImplementation(async (input: PrepareInput) => {
      events.push("prepare");
      return committedReceipt ?? newPreparedReceipt(input);
    });
    chargeOrReplay.mockImplementationOnce(
      async (prepared: NewPreparedReceipt) => {
        events.push("charge");
        committedReceipt = replayedReceipt(
          {
            rawIdempotencyKey: IDEMPOTENCY_KEY,
            organizationId: prepared.organizationId,
            scopedKey: `org/${ORGANIZATION_ID}/voice/message.ogg`,
            ttlSeconds: prepared.ttlSeconds,
            capabilityHost: prepared.capabilityHost,
          },
          {
            ...prepared.candidateClaims,
            chargeAmountUsd: String(COST),
          },
        );
        throw new Error("receipt acknowledgement lost");
      },
    );

    const firstResponse = await post({
      key: "voice/message.ogg",
      operation: "get",
      expiresIn: 600,
    });
    const firstBody = await firstResponse.text();

    expect(firstResponse.status).toBe(500);
    expect(firstBody).not.toContain(SIGNED_URL);
    expect(events).toEqual(["prepare", "head", "price", "mint", "charge"]);

    events.length = 0;
    const retryResponse = await post({
      key: "voice/message.ogg",
      operation: "get",
      expiresIn: 600,
    });

    expect(retryResponse.status).toBe(200);
    expect(await readJson(retryResponse)).toEqual({
      url: SIGNED_URL,
      expiresAt: "2026-08-17T12:10:00.000Z",
      receiptId: TRANSACTION_ID,
    });
    expect(events).toEqual(["prepare", "mint"]);
    expect(chargeOrReplay).toHaveBeenCalledTimes(1);
    expect(r2Head).toHaveBeenCalledTimes(1);
    expect(getServiceMethodCost).toHaveBeenCalledTimes(1);
  });

  test("re-mints from the durable race winner claims before disclosure", async () => {
    const durableClaims: ReceiptClaims = {
      issuedAt: FIXED_NOW_SECONDS - 30,
      expiresAt: FIXED_NOW_SECONDS + 570,
      capabilityHost: "blob-staging.eliza.app",
      chargeAmountUsd: String(COST),
    };
    mintStorageReadCapabilityUrl
      .mockImplementationOnce(async () => {
        events.push("mint");
        return SIGNED_URL;
      })
      .mockImplementationOnce(async () => {
        events.push("mint");
        return RACE_SIGNED_URL;
      });
    chargeOrReplay.mockImplementationOnce(async () => {
      events.push("charge");
      return {
        claims: durableClaims,
        transactionId: TRANSACTION_ID,
        replayed: true,
      };
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
      expiresIn: 600,
    });

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      url: RACE_SIGNED_URL,
      expiresAt: "2026-08-17T12:09:30.000Z",
      receiptId: TRANSACTION_ID,
    });
    expect(mintStorageReadCapabilityUrl).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        issuedAt: FIXED_NOW_SECONDS - 30,
        expiresAt: FIXED_NOW_SECONDS + 570,
      }),
    );
    expect(events).toEqual([
      "prepare",
      "head",
      "price",
      "mint",
      "charge",
      "mint",
    ]);
  });

  test("returns billing_state_conflict when a key is reused for another request", async () => {
    prepareReceipt.mockRejectedValueOnce(
      new TestStorageReadReceiptConflictError("idempotency_key_reused"),
    );

    const response = await post({
      key: "voice/different.ogg",
      operation: "get",
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      success: false,
      error:
        "Idempotency key was already used for a different storage read request",
      code: "billing_state_conflict",
    });
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("returns billing_state_conflict for an expired durable receipt", async () => {
    prepareReceipt.mockRejectedValueOnce(
      new TestStorageReadReceiptConflictError(
        "receipt_expired",
        TRANSACTION_ID,
      ),
    );

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      success: false,
      error: "Storage read receipt expired; retry with a new idempotency key",
      code: "billing_state_conflict",
      details: { receiptId: TRANSACTION_ID },
    });
    expect(r2Head).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("does not fabricate receipt details when a pre-debit candidate expires", async () => {
    prepareReceipt.mockRejectedValueOnce(
      new TestStorageReadReceiptConflictError("receipt_expired"),
    );

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      success: false,
      error: "Storage read receipt expired; retry with a new idempotency key",
      code: "billing_state_conflict",
    });
    expect(r2Head).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("fails closed with a private 503 for an unavailable or corrupt receipt", async () => {
    const privateSentinel = "voice/private-object.ogg:receipt-secret";
    prepareReceipt.mockRejectedValueOnce(
      new TestStorageReadReceiptUnavailableError(privateSentinel),
    );

    const response = await post({
      key: "voice/private-object.ogg",
      operation: "get",
    });
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(responseText)).toEqual({
      success: false,
      error: "Storage billing receipt service is temporarily unavailable",
      code: "service_unavailable",
    });
    expect(responseText).not.toContain(privateSentinel);
    expect(responseText).not.toContain(IDEMPOTENCY_KEY);
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      privateSentinel,
    );
    expect(loggerError).toHaveBeenCalledWith(
      "[storage proxy] Storage read receipt unavailable",
    );
    expect(r2Head).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
  });

  test("returns 402 without disclosing the candidate capability when charging is declined", async () => {
    chargeOrReplay.mockImplementationOnce(async () => {
      events.push("charge");
      throw new TestStorageReadReceiptInsufficientCreditsError();
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
      expiresIn: 300,
    });
    const bodyText = await response.text();

    expect(response.status).toBe(402);
    expect(JSON.parse(bodyText)).toEqual({
      error: "Insufficient credits",
      topUpUrl: "https://cloud.eliza.app/cloud/settings?tab=billing",
    });
    expect(bodyText).not.toContain(SIGNED_URL);
    expect(events).toEqual(["prepare", "head", "price", "mint", "charge"]);
  });

  test("returns a free capability with a null receipt and no charge", async () => {
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
      receiptId: null,
    });
    expect(mintStorageReadCapabilityUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        issuedAt: FIXED_NOW_SECONDS,
        expiresAt: FIXED_NOW_SECONDS + 3600,
      }),
    );
    expect(chargeOrReplay).not.toHaveBeenCalled();
    expect(events).toEqual(["prepare", "head", "price", "mint"]);
  });

  test("rejects negative and non-finite catalog prices before minting or charging", async () => {
    for (const invalidCost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      getServiceMethodCost.mockImplementationOnce(async () => {
        events.push("price");
        return invalidCost;
      });

      const response = await post({
        key: "voice/message.ogg",
        operation: "get",
      });

      expect(response.status).toBe(503);
      expect(await readJson(response)).toMatchObject({
        code: "service_unavailable",
      });
    }
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(3);
  });

  test("accepts the largest user key whose tenant-scoped UTF-8 key is 1024 bytes", async () => {
    const userKey = "a".repeat(983);

    const response = await post({ key: userKey, operation: "get" });

    expect(response.status).toBe(200);
    expect(r2Head).toHaveBeenCalledWith(`org/${ORGANIZATION_ID}/${userKey}`);
    expect(prepareReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        scopedKey: `org/${ORGANIZATION_ID}/${userKey}`,
      }),
    );
    expect(events).toEqual(["prepare", "head", "price", "mint", "charge"]);
  });

  test("rejects unsafe or byte-oversized keys before receipt, R2, or billing work", async () => {
    for (const key of [
      "a".repeat(984),
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

    expect(prepareReceipt).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("returns 404 for a missing object after receipt preparation but before pricing", async () => {
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
    expect(events).toEqual(["prepare", "head"]);
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });

  test("fails closed when a new request lacks native HEAD support", async () => {
    const response = await post(
      { key: "voice/message.ogg", operation: "get" },
      makeEnv({ get: mock() }),
    );

    expect(response.status).toBe(503);
    expect(await readJson(response)).toEqual({
      error: "Attachment storage proxy not available — server misconfigured",
    });
    expect(events).toEqual(["prepare"]);
    expect(loggerError).toHaveBeenCalledWith(
      "[storage proxy] Native R2 HEAD capability unavailable; signed read rejected",
    );
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
  });

  test("rejects a missing or blank private blob host before receipt preparation", async () => {
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
    expect(prepareReceipt).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
    expect(getServiceMethodCost).not.toHaveBeenCalled();
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledTimes(2);
  });

  test("maps signing configuration failure to 503 before charging without leaking details", async () => {
    mintStorageReadCapabilityUrl.mockImplementationOnce(async () => {
      events.push("mint");
      throw new TestStorageReadCapabilityConfigurationError("secret sentinel");
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(responseText).not.toContain("secret sentinel");
    expect(events).toEqual(["prepare", "head", "price", "mint"]);
    expect(chargeOrReplay).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      "[storage proxy] Signed read capability configuration unavailable",
    );
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      "secret sentinel",
    );
  });

  test("does not charge when capability generation fails unexpectedly", async () => {
    mintStorageReadCapabilityUrl.mockImplementationOnce(async () => {
      events.push("mint");
      throw new Error("signer failed");
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(500);
    expect(events).toEqual(["prepare", "head", "price", "mint"]);
    expect(chargeOrReplay).not.toHaveBeenCalled();
    expect(failureResponse).toHaveBeenCalledTimes(1);
  });

  test("does not mint or charge when pricing fails", async () => {
    getServiceMethodCost.mockImplementationOnce(async () => {
      events.push("price");
      throw new Error("pricing unavailable");
    });

    const response = await post({
      key: "voice/message.ogg",
      operation: "get",
    });

    expect(response.status).toBe(500);
    expect(events).toEqual(["prepare", "head", "price"]);
    expect(mintStorageReadCapabilityUrl).not.toHaveBeenCalled();
    expect(chargeOrReplay).not.toHaveBeenCalled();
  });
});
