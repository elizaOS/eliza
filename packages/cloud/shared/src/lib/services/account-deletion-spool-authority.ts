/**
 * Composes the account-deletion spool boundary on the dedicated backup host.
 * Durable operation journals are classified through their primary-database
 * reservation before any filesystem mutation; unknown journals, active locks,
 * or janitor writes fail closed instead of being reported absent.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core/edge";
import { inArray } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { agentSandboxBackups } from "../../db/schemas/agent-sandboxes";
import type { AccountDeletionSpoolAuthority } from "./account-deletion-provider-adapters";
import {
  type AgentBackupCaptureV3DurableOperationAuthority,
  AgentBackupCaptureV3Spool,
  type AgentBackupCaptureV3SpoolConfig,
} from "./agent-backup-capture-v2-spool";
import {
  inspectAgentBackupOrganizationSpoolAuthorityArtifacts,
  purgeAgentBackupOrganizationSpoolAuthorityArtifacts,
} from "./agent-backup-capture-v3-spool-cleanup";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AccountDeletionSpoolAuthorityDependencies {
  listDurableOperations(
    config: Readonly<AgentBackupCaptureV3SpoolConfig>,
  ): Promise<AgentBackupCaptureV3DurableOperationAuthority[]>;
  classifyOperations(operationIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  openExisting(
    config: Readonly<AgentBackupCaptureV3SpoolConfig>,
    input: {
      operationId: string;
      executionToken: string;
      requestSha256: string;
      authoritySha256: string;
      runtimePrincipalSha256: string;
    },
  ): Promise<AgentBackupCaptureV3Spool | undefined>;
  inspectAuthorityArtifacts(input: {
    stateDirectory: string;
    organizationId: string;
  }): Promise<"absent" | "present">;
  purgeAuthorityArtifacts(input: { stateDirectory: string; organizationId: string }): Promise<void>;
  executionToken(): string;
}

function spoolAuthorityError(code: string, message: string, cause?: unknown): never {
  throw new ElizaError(message, { code, cause, severity: "fatal" });
}

async function classifyOperations(
  operationIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (operationIds.length === 0) return new Map();
  const rows = await dbWrite
    .select({
      operationId: agentSandboxBackups.backup_operation_id,
      organizationId: agentSandboxBackups.catalog_organization_id,
    })
    .from(agentSandboxBackups)
    .where(inArray(agentSandboxBackups.backup_operation_id, [...operationIds]));
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!row.operationId || !row.organizationId || result.has(row.operationId)) {
      spoolAuthorityError(
        "ACCOUNT_DELETION_SPOOL_CLASSIFICATION_AMBIGUOUS",
        "Backup spool operation does not have one exact organization reservation",
      );
    }
    result.set(row.operationId, row.organizationId);
  }
  return result;
}

const DEFAULT_DEPENDENCIES: AccountDeletionSpoolAuthorityDependencies = {
  listDurableOperations: AgentBackupCaptureV3Spool.listDurableOperationAuthorities,
  classifyOperations,
  openExisting: AgentBackupCaptureV3Spool.openExisting,
  inspectAuthorityArtifacts: inspectAgentBackupOrganizationSpoolAuthorityArtifacts,
  purgeAuthorityArtifacts: purgeAgentBackupOrganizationSpoolAuthorityArtifacts,
  executionToken: randomUUID,
};

function requireOrganizationId(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    spoolAuthorityError(
      "ACCOUNT_DELETION_SPOOL_ORGANIZATION_INVALID",
      "Backup spool deletion requires a canonical organization identity",
    );
  }
}

function requireIdempotencyKey(value: string): void {
  if (
    !value ||
    value !== value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    spoolAuthorityError(
      "ACCOUNT_DELETION_SPOOL_IDEMPOTENCY_INVALID",
      "Backup spool deletion requires a canonical idempotency key",
    );
  }
}

/** Build the node-local authority; never invoke this in a Cloudflare request worker. */
export function createAccountDeletionSpoolAuthority(
  spool: Readonly<AgentBackupCaptureV3SpoolConfig>,
  dependenciesInput: Partial<AccountDeletionSpoolAuthorityDependencies> = {},
): AccountDeletionSpoolAuthority {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependenciesInput };

  const organizationOperations = async (
    organizationId: string,
  ): Promise<readonly AgentBackupCaptureV3DurableOperationAuthority[]> => {
    let durable: AgentBackupCaptureV3DurableOperationAuthority[];
    try {
      durable = await dependencies.listDurableOperations(spool);
    } catch (cause) {
      // error-policy:J2 inventory failures retain their cause behind the
      // account-deletion authority boundary for saga retry classification.
      spoolAuthorityError(
        "ACCOUNT_DELETION_SPOOL_INSPECTION_UNAVAILABLE",
        "Backup spool inventory could not be inspected",
        cause,
      );
    }
    const classifications = await dependencies.classifyOperations(
      durable.map((operation) => operation.operationId),
    );
    for (const operation of durable) {
      if (!classifications.has(operation.operationId)) {
        spoolAuthorityError(
          "ACCOUNT_DELETION_SPOOL_CLASSIFICATION_MISSING",
          "Backup spool inventory contains an operation without database authority",
        );
      }
    }
    return durable.filter(
      (operation) => classifications.get(operation.operationId) === organizationId,
    );
  };

  const inspect = async (organizationId: string): Promise<"absent" | "present"> => {
    requireOrganizationId(organizationId);
    if ((await organizationOperations(organizationId)).length > 0) return "present";
    return dependencies.inspectAuthorityArtifacts({
      stateDirectory: spool.stateDirectory,
      organizationId,
    });
  };

  return Object.freeze({
    async inspectOrganizationSpools({ organizationId }: { organizationId: string }) {
      return inspect(organizationId);
    },

    async purgeOrganizationSpools({
      organizationId,
      idempotencyKey,
    }: {
      organizationId: string;
      idempotencyKey: string;
    }) {
      requireOrganizationId(organizationId);
      requireIdempotencyKey(idempotencyKey);
      for (const operation of await organizationOperations(organizationId)) {
        let opened: AgentBackupCaptureV3Spool | undefined;
        try {
          opened = await dependencies.openExisting(spool, {
            operationId: operation.operationId,
            executionToken: dependencies.executionToken(),
            requestSha256: operation.requestSha256,
            authoritySha256: operation.authoritySha256,
            runtimePrincipalSha256: operation.runtimePrincipalSha256,
          });
          if (!opened) continue;
          const receipt = await opened.cleanup();
          if (receipt.status !== "complete") {
            spoolAuthorityError(
              "ACCOUNT_DELETION_SPOOL_PURGE_PENDING",
              "Backup spool cleanup remains pending",
            );
          }
        } catch (cause) {
          // error-policy:J2 release the exact operation authority, then
          // preserve the primary failure behind a typed deletion error.
          if (opened) {
            try {
              await opened.close();
            } catch (closeCause) {
              // error-policy:J2 neither the primary nor teardown failure may
              // be discarded at this durable retry boundary.
              spoolAuthorityError(
                "ACCOUNT_DELETION_SPOOL_PURGE_UNAVAILABLE",
                "Backup spool cleanup failed and could not release operation authority",
                new AggregateError([cause, closeCause]),
              );
            }
          }
          if (cause instanceof ElizaError) throw cause;
          spoolAuthorityError(
            "ACCOUNT_DELETION_SPOOL_PURGE_UNAVAILABLE",
            "Backup spool cleanup could not acquire exact operation authority",
            cause,
          );
        }
      }
      await dependencies.purgeAuthorityArtifacts({
        stateDirectory: spool.stateDirectory,
        organizationId,
      });
      if ((await inspect(organizationId)) !== "absent") {
        spoolAuthorityError(
          "ACCOUNT_DELETION_SPOOL_PURGE_UNVERIFIED",
          "Backup spool cleanup did not prove final organization absence",
        );
      }
    },
  });
}
