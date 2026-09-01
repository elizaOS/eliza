/**
 * Verifies durable paid routes reuse one combined standing resolution, consume
 * cold continuation in that resolver, and return bounded denials before any
 * route-owned external side effect.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const requireGenerativeRouteCaller = mock();
const shouldBlockUser = mock();
const findWithOrganizationForWrite = mock();
const warn = mock();

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller,
}));
mock.module("@/lib/services/admin", () => ({
  adminService: { shouldBlockUser },
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: { findWithOrganizationForWrite },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { warn },
}));

const { requirePaidRouteStanding } = await import("./paid-route-standing");

function context() {
  const values = new Map<string, string>([["traceId", "0".repeat(32)]]);
  return {
    get(name: string) {
      return values.get(name);
    },
  } as never;
}

const authorized = {
  user: { id: "user-1", organization_id: "org-1" },
  apiKeyId: "key-1",
  authSource: "combined_cache" as const,
  appScopeId: null,
};

beforeEach(() => {
  requireGenerativeRouteCaller.mockReset();
  shouldBlockUser.mockReset();
  findWithOrganizationForWrite.mockReset();
  warn.mockReset();
  shouldBlockUser.mockResolvedValue(false);
  findWithOrganizationForWrite.mockResolvedValue({
    id: "user-1",
    organization_id: "org-1",
    is_active: true,
    organization: {
      id: "org-1",
      is_active: true,
      account_lifecycle_state: "active",
      account_lifecycle_revision: 1,
      account_deletion_request_id: null,
    },
  });
});

describe("requirePaidRouteStanding", () => {
  test("uses one shared resolution and enables direct cold-continuation consumption", async () => {
    requireGenerativeRouteCaller.mockResolvedValueOnce(authorized);

    await expect(
      requirePaidRouteStanding(context(), { route: "storage.put" }),
    ).resolves.toEqual(authorized);

    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      {
        compatibility: undefined,
        awaitWarmingMs: 2_500,
      },
    );
    expect(shouldBlockUser).not.toHaveBeenCalled();
  });

  test("does not reread after an authoritative cold result", async () => {
    const coldAuthorized = {
      ...authorized,
      authSource: "combined_cache" as const,
    };
    requireGenerativeRouteCaller.mockResolvedValueOnce(coldAuthorized);

    await expect(
      requirePaidRouteStanding(context(), {
        route: "storage.presign",
        coldDeadlineMs: 4_000,
      }),
    ).resolves.toEqual(coldAuthorized);

    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(requireGenerativeRouteCaller).toHaveBeenCalledWith(
      expect.anything(),
      {
        compatibility: undefined,
        awaitWarmingMs: 4_000,
      },
    );
  });

  test("preserves a cached safe standing reason and emits route-bound diagnostics", async () => {
    requireGenerativeRouteCaller.mockRejectedValueOnce(
      new ApiError(403, "access_denied", "Organization is inactive", {
        reason: "organization_inactive",
      }),
    );

    await expect(
      requirePaidRouteStanding(context(), { route: "apps.domains.buy" }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Organization is inactive",
      details: { reason: "organization_inactive" },
    });

    expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[PaidRouteStanding] blocked external work",
      expect.objectContaining({
        route: "apps.domains.buy",
        status: 403,
        reason: "organization_inactive",
        providerDispatched: false,
      }),
    );
  });

  test("checks moderation on the non-cacheable compatibility path", async () => {
    requireGenerativeRouteCaller.mockResolvedValueOnce({
      ...authorized,
      apiKeyId: null,
      authSource: "compatibility",
    });
    shouldBlockUser.mockResolvedValueOnce(true);

    await expect(
      requirePaidRouteStanding(context(), {
        route: "connections.broker",
        compatibility: "raw",
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { reason: "moderation_blocked" },
    });

    expect(shouldBlockUser).toHaveBeenCalledWith("user-1");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "inactive wallet user",
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: false,
        organization: {
          id: "org-1",
          is_active: true,
          account_lifecycle_state: "active",
          account_lifecycle_revision: 1,
          account_deletion_request_id: null,
        },
      },
      "account_inactive",
    ],
    [
      "inactive mobile-key organization",
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: true,
        organization: {
          id: "org-1",
          is_active: false,
          account_lifecycle_state: "active",
          account_lifecycle_revision: 1,
          account_deletion_request_id: null,
        },
      },
      "organization_inactive",
    ],
    [
      "lifecycle-fenced wallet organization",
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: true,
        organization: {
          id: "org-1",
          is_active: true,
          account_lifecycle_state: "deletion_recovery",
          account_lifecycle_revision: 2,
          account_deletion_request_id: null,
        },
      },
      "organization_inactive",
    ],
    [
      "deletion-requested mobile-key organization",
      {
        id: "user-1",
        organization_id: "org-1",
        is_active: true,
        organization: {
          id: "org-1",
          is_active: true,
          account_lifecycle_state: "active",
          account_lifecycle_revision: 2,
          account_deletion_request_id: "00000000-0000-4000-8000-000000000001",
        },
      },
      "organization_inactive",
    ],
  ])(
    "fences a %s through primary lifecycle authority",
    async (_name, current, reason) => {
      requireGenerativeRouteCaller.mockResolvedValueOnce({
        ...authorized,
        apiKeyId: null,
        authSource: "compatibility",
      });
      findWithOrganizationForWrite.mockResolvedValueOnce(current);

      await expect(
        requirePaidRouteStanding(context(), {
          route: "connections.broker",
          compatibility: "raw",
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { reason },
      });

      expect(findWithOrganizationForWrite).toHaveBeenCalledTimes(1);
      expect(requireGenerativeRouteCaller).toHaveBeenCalledTimes(1);
      expect(shouldBlockUser).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[PaidRouteStanding] blocked external work",
        expect.objectContaining({ reason, providerDispatched: false }),
      );
    },
  );
});
