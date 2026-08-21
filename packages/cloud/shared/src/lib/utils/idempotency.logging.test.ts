/** Proves webhook idempotency failures never log provider-controlled keys or errors. */

import { afterAll, describe, expect, mock, test } from "bun:test";
import * as realDbClient from "../../db/client";
import * as realIdempotencySchema from "../../db/schemas/idempotency-keys";
import * as realLogger from "./logger";

const realDbClientExports = { ...realDbClient };
const realIdempotencySchemaExports = { ...realIdempotencySchema };
const realLoggerExports = { ...realLogger };

const sentinelKey = "whatsapp:SENTINEL_PROVIDER_MESSAGE_ID";
const sentinelSource = "SENTINEL_PROVIDER_SOURCE";
const sentinelError = "SENTINEL_DATABASE_ERROR_BODY";
const loggerError = mock();

const fail = () => {
  throw new Error(sentinelError);
};

mock.module("../../db/client", () => ({
  dbRead: { select: mock(fail) },
  dbWrite: {
    delete: mock(fail),
    insert: mock(fail),
  },
}));

mock.module("../../db/schemas/idempotency-keys", () => ({
  idempotencyKeys: {
    expires_at: {},
    id: {},
    key: {},
  },
}));

mock.module("./logger", () => ({
  logger: {
    debug: mock(),
    error: loggerError,
    info: mock(),
    warn: mock(),
  },
}));

const {
  cleanupExpiredKeys,
  clearProcessedMessages,
  getProcessedMessagesCount,
  isAlreadyProcessed,
  markAsProcessed,
  releaseProcessingClaim,
  tryClaimForProcessing,
} = await import("./idempotency");

afterAll(() => {
  mock.module("../../db/client", () => realDbClientExports);
  mock.module("../../db/schemas/idempotency-keys", () => realIdempotencySchemaExports);
  mock.module("./logger", () => realLoggerExports);
});

describe("idempotency diagnostics", () => {
  test("emit only a constant failure class for every persistence operation", async () => {
    expect(await isAlreadyProcessed(sentinelKey)).toBe(false);
    expect(await tryClaimForProcessing(sentinelKey, sentinelSource)).toBe(true);
    await expect(releaseProcessingClaim(sentinelKey)).resolves.toBeUndefined();
    await expect(markAsProcessed(sentinelKey, sentinelSource)).resolves.toBeUndefined();
    expect(await getProcessedMessagesCount()).toBe(0);
    expect(await cleanupExpiredKeys()).toBe(0);
    await expect(clearProcessedMessages()).resolves.toBeUndefined();

    const serializedLogs = JSON.stringify(loggerError.mock.calls);
    expect(serializedLogs).not.toContain(sentinelKey);
    expect(serializedLogs).not.toContain(sentinelSource);
    expect(serializedLogs).not.toContain(sentinelError);
    expect(loggerError).toHaveBeenCalledTimes(7);
    for (const call of loggerError.mock.calls) {
      expect(call[1]).toEqual({ failureClass: "idempotency_store_failed" });
    }
  });
});
