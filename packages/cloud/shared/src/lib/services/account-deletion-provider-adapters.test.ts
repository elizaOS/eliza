/** Proves the default deletion adapters never infer remote spool absence from local database state. */

import { describe, expect, mock, test } from "bun:test";
import type { RuntimeR2Bucket } from "../storage/r2-runtime-binding";
import {
  type AccountDeletionSpoolAuthority,
  createAccountDeletionProviderAdapters,
} from "./account-deletion-provider-adapters";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const context: AccountDeletionProviderContext = {
  requestId: "50000000-0000-4000-8000-000000000001",
  requestDigest: "a".repeat(64),
  userId: "20000000-0000-4000-8000-000000000001",
  organizationId: ORGANIZATION_ID,
  stewardUserId: "steward-personal",
  lifecycleRevision: 2,
  blob: {} as RuntimeR2Bucket,
};

function spoolAuthority(input: {
  inspect: AccountDeletionSpoolAuthority["inspectOrganizationSpools"];
  purge?: AccountDeletionSpoolAuthority["purgeOrganizationSpools"];
}): AccountDeletionSpoolAuthority {
  return {
    inspectOrganizationSpools: input.inspect,
    purgeOrganizationSpools: input.purge ?? mock(async () => undefined),
  };
}

describe("account deletion remote spool adapter", () => {
  test("fails closed when no canonical spool authority is configured", async () => {
    const adapter = createAccountDeletionProviderAdapters().spools;

    await expect(adapter.inspect(context)).resolves.toEqual({
      state: "action_required",
      errorCode: "BACKUP_SPOOL_AUTHORITY_UNAVAILABLE",
    });
    await expect(adapter.execute(context, "delete-spools-once")).rejects.toThrow(
      "Backup spool authority is not configured",
    );
  });

  test("completes only after the authority confirms organization spool absence", async () => {
    const inspect = mock(async () => "absent" as const);
    const purge = mock(async () => undefined);
    const adapter = createAccountDeletionProviderAdapters({
      spoolAuthority: spoolAuthority({ inspect, purge }),
    }).spools;

    const result = await adapter.inspect(context);

    expect(result).toEqual({
      state: "complete",
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(inspect).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
    expect(purge).not.toHaveBeenCalled();
  });

  test("passes the saga idempotency key through the remote purge boundary", async () => {
    const inspect = mock(async () => "present" as const);
    const purge = mock(async () => undefined);
    const adapter = createAccountDeletionProviderAdapters({
      spoolAuthority: spoolAuthority({ inspect, purge }),
    }).spools;

    await expect(adapter.inspect(context)).resolves.toEqual({ state: "needs_execution" });
    await adapter.execute(context, "account-deletion:request:spools");

    expect(purge).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      idempotencyKey: "account-deletion:request:spools",
    });
  });

  test("reconciles a lost purge response by inspection without a second mutation", async () => {
    let state: "present" | "absent" = "present";
    const inspect = mock(async () => state);
    const purge = mock(async () => {
      state = "absent";
      throw new Error("response lost after remote spool purge");
    });
    const adapter = createAccountDeletionProviderAdapters({
      spoolAuthority: spoolAuthority({ inspect, purge }),
    }).spools;

    await expect(adapter.inspect(context)).resolves.toEqual({ state: "needs_execution" });
    await expect(adapter.execute(context, "account-deletion:request:spools")).rejects.toThrow(
      "response lost",
    );
    await expect(adapter.inspect(context)).resolves.toEqual({
      state: "complete",
      receiptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(purge).toHaveBeenCalledTimes(1);
  });
});
