/**
 * Proves deletion-owned spool cleanup classifies every journal and reconciles
 * retries without cross-tenant mutation.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AccountDeletionSpoolAuthorityDependencies } from "./account-deletion-spool-authority";
import { createAccountDeletionSpoolAuthority } from "./account-deletion-spool-authority";
import type { AgentBackupCaptureV3DurableOperationAuthority } from "./agent-backup-capture-v2-spool";
import { inspectAgentBackupOrganizationSpoolAuthorityArtifacts } from "./agent-backup-capture-v3-spool-cleanup";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "20000000-0000-4000-8000-000000000002";
const OPERATION_ID = "30000000-0000-4000-8000-000000000003";
const OTHER_OPERATION_ID = "40000000-0000-4000-8000-000000000004";
const spool = {
  stateDirectory: "/var/lib/eliza-backup-catalog/spool",
  maxSpoolBytes: 1024 ** 3,
  minFreeBytes: 1024 ** 2,
};

function operation(operationId: string): AgentBackupCaptureV3DurableOperationAuthority {
  return {
    operationId,
    requestSha256: "a".repeat(64),
    authoritySha256: "b".repeat(64),
    runtimePrincipalSha256: "c".repeat(64),
    phase: "sealed",
    recordCaptured: false,
  };
}

function dependencies(input: {
  durable: AgentBackupCaptureV3DurableOperationAuthority[];
  classifications: ReadonlyMap<string, string>;
  cleanup?: () => Promise<{ operationId: string; status: "complete" | "pending" }>;
  artifacts?: "absent" | "present";
}): AccountDeletionSpoolAuthorityDependencies & {
  openExisting: ReturnType<typeof mock>;
  purgeAuthorityArtifacts: ReturnType<typeof mock>;
} {
  let durable = [...input.durable];
  let artifacts = input.artifacts ?? "absent";
  const close = mock(async () => undefined);
  const cleanup = mock(
    input.cleanup ??
      (async () => {
        durable = [];
        return { operationId: OPERATION_ID, status: "complete" as const };
      }),
  );
  const openExisting = mock(async () => ({ cleanup, close }));
  const purgeAuthorityArtifacts = mock(async () => {
    artifacts = "absent";
  });
  return {
    listDurableOperations: mock(async () => durable),
    classifyOperations: mock(async () => input.classifications),
    openExisting: openExisting as never,
    inspectAuthorityArtifacts: mock(async () => artifacts),
    purgeAuthorityArtifacts,
    executionToken: mock(() => "50000000-0000-4000-8000-000000000005"),
  };
}

describe("account deletion spool authority composition", () => {
  test("does not report an absent or unmounted StateDirectory as absence", async () => {
    await expect(
      inspectAgentBackupOrganizationSpoolAuthorityArtifacts({
        stateDirectory: "/var/lib/eliza-backup-catalog/definitely-unmounted-account-deletion-test",
        organizationId: ORGANIZATION_ID,
      }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_SPOOL_STATE_DIRECTORY_UNAVAILABLE",
    });
  });

  test("fails closed when any durable journal lacks database organization authority", async () => {
    const authority = createAccountDeletionSpoolAuthority(
      spool,
      dependencies({ durable: [operation(OPERATION_ID)], classifications: new Map() }),
    );

    await expect(
      authority.inspectOrganizationSpools({ organizationId: ORGANIZATION_ID }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DELETION_SPOOL_CLASSIFICATION_MISSING" });
  });

  test("reports both operation journals and janitor authority artifacts as present", async () => {
    const operationAuthority = createAccountDeletionSpoolAuthority(
      spool,
      dependencies({
        durable: [operation(OPERATION_ID), operation(OTHER_OPERATION_ID)],
        classifications: new Map([
          [OPERATION_ID, ORGANIZATION_ID],
          [OTHER_OPERATION_ID, OTHER_ORGANIZATION_ID],
        ]),
      }),
    );
    await expect(
      operationAuthority.inspectOrganizationSpools({ organizationId: ORGANIZATION_ID }),
    ).resolves.toBe("present");

    const artifactAuthority = createAccountDeletionSpoolAuthority(
      spool,
      dependencies({ durable: [], classifications: new Map(), artifacts: "present" }),
    );
    await expect(
      artifactAuthority.inspectOrganizationSpools({ organizationId: ORGANIZATION_ID }),
    ).resolves.toBe("present");
  });

  test("cleans target operations and bound receipts, then verifies absence", async () => {
    const deps = dependencies({
      durable: [operation(OPERATION_ID)],
      classifications: new Map([[OPERATION_ID, ORGANIZATION_ID]]),
      artifacts: "present",
    });
    const authority = createAccountDeletionSpoolAuthority(spool, deps);

    await authority.purgeOrganizationSpools({
      organizationId: ORGANIZATION_ID,
      idempotencyKey: "account-deletion:request:spools",
    });

    expect(deps.openExisting).toHaveBeenCalledTimes(1);
    expect(deps.openExisting).toHaveBeenCalledWith(
      spool,
      expect.objectContaining({
        operationId: OPERATION_ID,
        requestSha256: "a".repeat(64),
        authoritySha256: "b".repeat(64),
        runtimePrincipalSha256: "c".repeat(64),
      }),
    );
    expect(deps.purgeAuthorityArtifacts).toHaveBeenCalledWith({
      stateDirectory: spool.stateDirectory,
      organizationId: ORGANIZATION_ID,
    });
  });

  test("keeps pending cleanup retryable and retains authority artifacts", async () => {
    const close = mock(async () => undefined);
    const deps = dependencies({
      durable: [operation(OPERATION_ID)],
      classifications: new Map([[OPERATION_ID, ORGANIZATION_ID]]),
      cleanup: async () => ({ operationId: OPERATION_ID, status: "pending" }),
    });
    deps.openExisting.mockImplementation(async () => ({
      cleanup: async () => ({ operationId: OPERATION_ID, status: "pending" }),
      close,
    }));
    const authority = createAccountDeletionSpoolAuthority(spool, deps);

    await expect(
      authority.purgeOrganizationSpools({
        organizationId: ORGANIZATION_ID,
        idempotencyKey: "account-deletion:request:spools",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DELETION_SPOOL_PURGE_PENDING" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(deps.purgeAuthorityArtifacts).not.toHaveBeenCalled();
  });
});
