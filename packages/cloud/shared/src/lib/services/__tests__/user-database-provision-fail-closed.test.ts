/**
 * #9853 P1.4 — an "isolated" app deploy must FAIL CLOSED when no tenant-DB
 * provisioning backend is wired (the provisioning daemon isn't armed), never
 * silently fall back to the shared cloud DATABASE_URL. A bare UserDatabaseService
 * (no backend) is exactly the unarmed-daemon case.
 */

import { describe, expect, mock, test } from "bun:test";

const findById = mock();
const findStateByAppId = mock();
const trySetProvisioning = mock();
const updateState = mock();
const findStateByAppIdForWrite = mock();

mock.module("../../../db/repositories/apps", () => ({
  appsRepository: { findById },
}));
mock.module("../../../db/repositories/app-databases", () => ({
  appDatabasesRepository: {
    findStateByAppId,
    trySetProvisioning,
    updateState,
    findStateByAppIdForWrite,
  },
}));
mock.module("../field-encryption", () => ({
  fieldEncryption: {
    encrypt: mock(async (_org: string, value: string) => `enc:${value}`),
    decryptIfNeeded: mock(async (value: string) => value),
  },
}));

import { UserDatabaseService } from "../user-database";

describe("provisionDatabase — fail closed without a tenant-DB backend", () => {
  test("returns success:false and never the shared DATABASE_URL when no backend is wired", async () => {
    findById.mockResolvedValue({ id: "app-1", organization_id: "org-1" });
    findStateByAppId.mockResolvedValue(undefined);
    trySetProvisioning.mockResolvedValue({ user_database_status: "provisioning" });
    updateState.mockResolvedValue(undefined);
    // A shared cloud DSN IS available — the fix must refuse to use it anyway.
    process.env.DATABASE_URL = "postgres://shared-cloud-db/main";

    // Bare service == no tenant-DB provisioning backend (the unarmed-daemon case).
    const svc = new UserDatabaseService();
    const result = await svc.provisionDatabase("app-1", "My App");

    expect(result.success).toBe(false);
    expect(result.connectionUri).toBeUndefined();
    expect(result.error).toContain("no tenant-DB provisioning backend is wired");
    // Persisted an error state rather than a (shared) "ready" — no silent downgrade.
    expect(updateState).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({ user_database_status: "error" }),
    );
  });
});
