/**
 * Pins the fail-closed error policy of UsersService: an internal DB failure on a
 * user read must PROPAGATE (a broken pipeline must never read as "no user"),
 * while a genuine not-found result stays a distinct `undefined`. Deterministic
 * repository fixtures; the retry helper is a pass-through so the real failover
 * branch in getByStewardId is exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const findById = mock();
const findByStewardIdWithOrganization = mock();
const findByStewardIdWithOrganizationForWrite = mock();

mock.module("../../db/repositories", () => ({
  usersRepository: {
    findById,
    findByStewardIdWithOrganization,
    findByStewardIdWithOrganizationForWrite,
  },
  apiKeysRepository: { listByUser: mock(async () => []) },
  organizationsRepository: { findBySlug: mock(), create: mock(), delete: mock() },
}));

// Pass-through: invoke the wrapped query once and let its errors surface, so the
// read→primary failover and the terminal rethrow in getByStewardId run for real.
mock.module("../../db/retry-transient", () => ({
  retryOnTransientDbError: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

mock.module("../cache/client", () => ({
  cache: {
    get: mock(async () => undefined),
    set: mock(async () => undefined),
    del: mock(async () => undefined),
  },
}));

mock.module("../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

mock.module("./inference-auth-cache", () => ({
  invalidateInferenceAuthContextsByKeyHashes: mock(async () => undefined),
}));

const { UsersService } = await import(`./users.ts?test=users-error-policy-${Date.now()}`);
const service = new UsersService();

beforeEach(() => {
  findById.mockReset();
  findByStewardIdWithOrganization.mockReset();
  findByStewardIdWithOrganizationForWrite.mockReset();
});

afterEach(() => {
  mock.restore();
});

describe("UsersService error policy — internal failure vs designed-empty", () => {
  test("getById propagates a DB read failure (fail closed, not undefined)", async () => {
    findById.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await expect(service.getById("user-1")).rejects.toThrow("connection terminated unexpectedly");
    expect(findById).toHaveBeenCalledTimes(1);
  });

  test("getById returns undefined for a genuine not-found (designed empty, distinct)", async () => {
    findById.mockResolvedValue(undefined);

    await expect(service.getById("missing")).resolves.toBeUndefined();
  });

  test("getByStewardId rethrows when both replica and primary fail (never fabricates no-user)", async () => {
    findByStewardIdWithOrganization.mockRejectedValue(new Error("replica EOF"));
    findByStewardIdWithOrganizationForWrite.mockRejectedValue(new Error("primary down"));

    // Fails closed: the auth hot path must 500, not treat the session as unknown.
    await expect(service.getByStewardId("steward-1")).rejects.toThrow("primary down");
    expect(findByStewardIdWithOrganization).toHaveBeenCalledTimes(1);
    expect(findByStewardIdWithOrganizationForWrite).toHaveBeenCalledTimes(1);
  });

  test("getByStewardId recovers via the primary when only the replica fails", async () => {
    findByStewardIdWithOrganization.mockRejectedValue(new Error("replica EOF"));
    findByStewardIdWithOrganizationForWrite.mockResolvedValue({
      id: "user-9",
      organization: { id: "org-9" },
    });

    const user = await service.getByStewardId("steward-9");
    expect(user?.id).toBe("user-9");
  });

  test("getByStewardId returns undefined for a genuine not-found (distinct from failure)", async () => {
    findByStewardIdWithOrganization.mockResolvedValue(undefined);

    await expect(service.getByStewardId("steward-none")).resolves.toBeUndefined();
    expect(findByStewardIdWithOrganizationForWrite).not.toHaveBeenCalled();
  });
});
