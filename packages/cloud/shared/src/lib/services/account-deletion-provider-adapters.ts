/**
 * Binds account-deletion saga phases to canonical provider and database
 * services. Every inspection re-reads provider-visible state; successful
 * mutations are not considered complete until a later inspection proves it.
 */

import { createHash } from "node:crypto";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import {
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../../db/schemas/agent-backup-catalog";
import {
  agentBackupRestoreReceipts,
  agentVaultKeySeedReceipts,
} from "../../db/schemas/agent-backup-restore-history";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../db/schemas/agent-sandboxes";
import {
  agentVaultKeyAuthorities,
  agentVaultKeyBackupBindings,
  agentVaultKeyGenerations,
} from "../../db/schemas/agent-vault-key-authority";
import { apps } from "../../db/schemas/apps";
import { managedDomains } from "../../db/schemas/managed-domains";
import {
  orgStorageDeleteOperations,
  orgStorageGcOutbox,
  orgStorageObjects,
  orgStoragePutOperations,
} from "../../db/schemas/org-storage-mutations";
import { orgStorageReadOperations } from "../../db/schemas/org-storage-reads";
import { organizations } from "../../db/schemas/organizations";
import { userVoices } from "../../db/schemas/user-voices";
import {
  type AgentBackupObjectStoreRegistry,
  type AgentBackupStorageAuthority,
} from "../storage/agent-backup-object-store";
import type { RuntimeR2Bucket, RuntimeR2ObjectMetadata } from "../storage/r2-runtime-binding";
import { getStripe } from "../stripe";
import type {
  AccountDeletionProviderAdapter,
  AccountDeletionProviderAdapters,
  AccountDeletionProviderContext,
  AccountDeletionProviderInspection,
  AccountDeletionProviderPhase,
} from "./account-deletion-saga";
import { deleteAppWithCleanup } from "./app-cleanup";
import { elizaSandboxService } from "./eliza-sandbox";
import { oauthService } from "./oauth";
import {
  deactivateStewardPlatformUser,
  deleteStewardPlatformUser,
  inspectStewardPlatformUser,
} from "./steward-platform-users";
import { voiceCloningService } from "./voice-cloning";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function complete(
  context: AccountDeletionProviderContext,
  phase: AccountDeletionProviderPhase,
  evidence = "absent",
): AccountDeletionProviderInspection {
  return {
    state: "complete",
    receiptDigest: digest(
      `account-deletion-provider-receipt:v1:${context.requestDigest}:${phase}:${evidence}`,
    ),
  };
}

function belongsToOrganization(object: RuntimeR2ObjectMetadata, organizationId: string): boolean {
  return (
    object.customMetadata?.organizationId === organizationId ||
    (typeof object.key === "string" && object.key.split("/").includes(organizationId))
  );
}

async function listOrganizationObjectKeys(
  bucket: RuntimeR2Bucket,
  organizationId: string,
): Promise<string[]> {
  if (!bucket.list) throw new Error("Account deletion object storage cannot be inspected");
  const keys: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let truncated = true;
  while (truncated) {
    const page = await bucket.list({ cursor, include: ["customMetadata"], limit: 1_000 });
    keys.push(
      ...page.objects.flatMap((object) =>
        belongsToOrganization(object, organizationId) && object.key ? [object.key] : [],
      ),
    );
    truncated = page.truncated;
    if (!truncated) break;
    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new Error("Account deletion object listing did not advance");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  return keys.sort();
}

function isMissingStripeResource(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.code === "resource_missing" || candidate.statusCode === 404;
}

export interface AccountDeletionProviderAdapterDependencies {
  backupRegistry?: AgentBackupObjectStoreRegistry;
  spoolAuthority?: AccountDeletionSpoolAuthority;
}

export interface AccountDeletionSpoolAuthority {
  inspectOrganizationSpools(input: { organizationId: string }): Promise<"absent" | "present">;
  purgeOrganizationSpools(input: { organizationId: string; idempotencyKey: string }): Promise<void>;
}

async function deleteBackupDatabaseGraph(organizationId: string): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    await tx
      .delete(agentBackupRestoreReceipts)
      .where(eq(agentBackupRestoreReceipts.organization_id, organizationId));
    await tx
      .delete(agentVaultKeySeedReceipts)
      .where(eq(agentVaultKeySeedReceipts.organization_id, organizationId));
    await tx
      .delete(agentBackupRestoreLeases)
      .where(eq(agentBackupRestoreLeases.organization_id, organizationId));
    await tx
      .delete(agentBackupRestoreOperations)
      .where(eq(agentBackupRestoreOperations.organization_id, organizationId));
    await tx
      .delete(agentBackupGcOutbox)
      .where(eq(agentBackupGcOutbox.organization_id, organizationId));
    await tx
      .delete(agentVaultKeyBackupBindings)
      .where(eq(agentVaultKeyBackupBindings.organization_id, organizationId));
    await tx
      .delete(agentBackupObjects)
      .where(eq(agentBackupObjects.organization_id, organizationId));
    await tx
      .update(agentSandboxBackups)
      .set({ parent_backup_id: null, base_backup_id: null })
      .where(
        or(
          eq(agentSandboxBackups.catalog_organization_id, organizationId),
          eq(agentSandboxBackups.recovery_organization_id, organizationId),
        ),
      );
    await tx
      .delete(agentSandboxBackups)
      .where(
        or(
          eq(agentSandboxBackups.catalog_organization_id, organizationId),
          eq(agentSandboxBackups.recovery_organization_id, organizationId),
        ),
      );
    await tx
      .delete(agentBackupCatalogAuthorities)
      .where(eq(agentBackupCatalogAuthorities.organization_id, organizationId));
  });
}

async function backupRowsRemain(organizationId: string): Promise<boolean> {
  const [object] = await dbWrite
    .select({ id: agentBackupObjects.id })
    .from(agentBackupObjects)
    .where(eq(agentBackupObjects.organization_id, organizationId))
    .limit(1);
  if (object) return true;
  const [backup] = await dbWrite
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(
      or(
        eq(agentSandboxBackups.catalog_organization_id, organizationId),
        eq(agentSandboxBackups.recovery_organization_id, organizationId),
      ),
    )
    .limit(1);
  return backup !== undefined;
}

function storedAuthority(
  object: typeof agentBackupObjects.$inferSelect,
): AgentBackupStorageAuthority {
  return {
    provider: object.provider,
    transport: object.transport,
    endpointAlias: object.endpoint_alias,
    endpointIdentityFingerprint: object.endpoint_identity_fingerprint,
    bucket: object.bucket,
    region: object.region,
  };
}

async function inspectBackupObjects(
  context: AccountDeletionProviderContext,
  registry: AgentBackupObjectStoreRegistry,
): Promise<"absent" | "present"> {
  const objects = await dbWrite
    .select()
    .from(agentBackupObjects)
    .where(eq(agentBackupObjects.organization_id, context.organizationId));
  if (objects.length === 0) {
    if (await backupRowsRemain(context.organizationId)) {
      await deleteBackupDatabaseGraph(context.organizationId);
    }
    return "absent";
  }
  let present = false;
  for (const object of objects) {
    const store = registry.forStoredObject(storedAuthority(object));
    const observed = await store.head(object.object_key);
    if (observed.status === "present") present = true;
  }
  if (!present) {
    await deleteBackupDatabaseGraph(context.organizationId);
    return "absent";
  }
  return "present";
}

async function executeBackupObjectDeletion(
  context: AccountDeletionProviderContext,
  registry: AgentBackupObjectStoreRegistry,
): Promise<void> {
  const objects = await dbWrite
    .select()
    .from(agentBackupObjects)
    .where(eq(agentBackupObjects.organization_id, context.organizationId));
  for (const object of objects) {
    const store = registry.forStoredObject(storedAuthority(object));
    const observed = await store.head(object.object_key);
    if (observed.status === "present") {
      await store.delete({ key: object.object_key, locator: observed.locator });
    }
  }
}

async function clearVaultKeyGraph(organizationId: string): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    await tx
      .delete(agentVaultKeySeedReceipts)
      .where(eq(agentVaultKeySeedReceipts.organization_id, organizationId));
    await tx
      .delete(agentVaultKeyBackupBindings)
      .where(eq(agentVaultKeyBackupBindings.organization_id, organizationId));
    await tx
      .delete(agentVaultKeyAuthorities)
      .where(eq(agentVaultKeyAuthorities.organization_id, organizationId));
    await tx
      .update(agentVaultKeyGenerations)
      .set({ supersedes_generation_id: null })
      .where(eq(agentVaultKeyGenerations.organization_id, organizationId));
    await tx
      .delete(agentVaultKeyGenerations)
      .where(eq(agentVaultKeyGenerations.organization_id, organizationId));
  });
}

async function vaultRowsRemain(organizationId: string): Promise<boolean> {
  const [generation] = await dbWrite
    .select({ id: agentVaultKeyGenerations.generation_id })
    .from(agentVaultKeyGenerations)
    .where(eq(agentVaultKeyGenerations.organization_id, organizationId))
    .limit(1);
  if (generation) return true;
  const [authority] = await dbWrite
    .select({ id: agentVaultKeyAuthorities.current_generation_id })
    .from(agentVaultKeyAuthorities)
    .where(eq(agentVaultKeyAuthorities.organization_id, organizationId))
    .limit(1);
  return authority !== undefined;
}

async function deleteLocalRestrictiveRows(context: AccountDeletionProviderContext): Promise<void> {
  await dbWrite.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM affiliate_payout_outbox WHERE affiliate_user_id = ${context.userId}`,
    );
    await tx.execute(
      sql`DELETE FROM app_reservation_settlement_quarantines WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM app_reservation_settlements WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM container_billing_legacy_ledger_bindings WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM container_billing_records WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM compute_billing_rate_segments WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM agent_billing_records WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM payment_request_receipts WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM stripe_checkout_legacy_quarantine WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM stripe_checkout_orders WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM stripe_customer_attempts WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`DELETE FROM stripe_customer_legacy_quarantines WHERE organization_id = ${context.organizationId}`,
    );
    await tx.execute(
      sql`UPDATE admin_users SET granted_by = NULL WHERE granted_by = ${context.userId}`,
    );
    await tx.execute(
      sql`UPDATE moderation_violations SET reviewed_by = NULL WHERE reviewed_by = ${context.userId}`,
    );
    await tx.execute(
      sql`UPDATE token_redemptions SET reviewed_by = NULL WHERE reviewed_by = ${context.userId}`,
    );
    await tx.execute(
      sql`UPDATE user_mcps SET verified_by = NULL WHERE verified_by = ${context.userId}`,
    );
    await tx.execute(
      sql`UPDATE user_moderation_status SET banned_by = NULL WHERE banned_by = ${context.userId}`,
    );
  });
}

/** Creates the production adapter set; tests may inject exact provider doubles. */
export function createAccountDeletionProviderAdapters(
  dependencies: AccountDeletionProviderAdapterDependencies = {},
): AccountDeletionProviderAdapters {
  const adapters = {
    steward_deactivation: {
      async inspect(context) {
        const state = await inspectStewardPlatformUser(context.stewardUserId);
        return state === "deactivated"
          ? complete(context, "steward_deactivation")
          : state === "absent"
            ? { state: "action_required", errorCode: "STEWARD_IDENTITY_MISSING_DURING_RECOVERY" }
            : { state: "needs_execution" };
      },
      async execute(context) {
        await deactivateStewardPlatformUser(context.stewardUserId);
      },
    },
    stripe: {
      async inspect(context) {
        const [organization] = await dbWrite
          .select({ customerId: organizations.stripe_customer_id })
          .from(organizations)
          .where(eq(organizations.id, context.organizationId))
          .limit(1);
        if (!organization?.customerId) return complete(context, "stripe");
        try {
          const customer = await getStripe().customers.retrieve(organization.customerId);
          return "deleted" in customer && customer.deleted
            ? complete(context, "stripe")
            : { state: "needs_execution" };
        } catch (error) {
          if (isMissingStripeResource(error)) return complete(context, "stripe");
          throw error;
        }
      },
      async execute(context, idempotencyKey) {
        const [organization] = await dbWrite
          .select({ customerId: organizations.stripe_customer_id })
          .from(organizations)
          .where(eq(organizations.id, context.organizationId))
          .limit(1);
        if (!organization?.customerId) return;
        try {
          await getStripe().customers.del(organization.customerId, {}, { idempotencyKey });
        } catch (error) {
          if (!isMissingStripeResource(error)) throw error;
        }
      },
    },
    domains: {
      async inspect(context) {
        const rows = await dbWrite
          .select({ registrar: managedDomains.registrar })
          .from(managedDomains)
          .where(eq(managedDomains.organizationId, context.organizationId));
        if (rows.some((row) => row.registrar === "cloudflare")) {
          return { state: "action_required", errorCode: "DOMAIN_TRANSFER_REQUIRED" };
        }
        return rows.length === 0 ? complete(context, "domains") : { state: "needs_execution" };
      },
      async execute(context) {
        await dbWrite
          .delete(managedDomains)
          .where(
            and(
              eq(managedDomains.organizationId, context.organizationId),
              ne(managedDomains.registrar, "cloudflare"),
            ),
          );
      },
    },
    secondary_backups: {
      async inspect(context) {
        if (!(await backupRowsRemain(context.organizationId))) {
          return complete(context, "secondary_backups");
        }
        if (!dependencies.backupRegistry) {
          return {
            state: "action_required",
            errorCode: "BACKUP_STORAGE_AUTHORITY_UNAVAILABLE",
          };
        }
        return (await inspectBackupObjects(context, dependencies.backupRegistry)) === "absent"
          ? complete(context, "secondary_backups")
          : { state: "needs_execution" };
      },
      async execute(context) {
        if (!dependencies.backupRegistry) {
          throw new Error("Backup storage authority is not configured");
        }
        await executeBackupObjectDeletion(context, dependencies.backupRegistry);
      },
    },
    spools: {
      async inspect(context) {
        if (!dependencies.spoolAuthority) {
          return {
            state: "action_required",
            errorCode: "BACKUP_SPOOL_AUTHORITY_UNAVAILABLE",
          };
        }
        return (await dependencies.spoolAuthority.inspectOrganizationSpools({
          organizationId: context.organizationId,
        })) === "absent"
          ? complete(context, "spools")
          : { state: "needs_execution" };
      },
      async execute(context, idempotencyKey) {
        if (!dependencies.spoolAuthority) {
          throw new Error("Backup spool authority is not configured");
        }
        await dependencies.spoolAuthority.purgeOrganizationSpools({
          organizationId: context.organizationId,
          idempotencyKey,
        });
      },
    },
    compute_containers: {
      async inspect(context) {
        const [row] = await dbWrite
          .select({ id: agentSandboxes.id })
          .from(agentSandboxes)
          .where(eq(agentSandboxes.organization_id, context.organizationId))
          .limit(1);
        return row ? { state: "needs_execution" } : complete(context, "compute_containers");
      },
      async execute(context) {
        const rows = await dbWrite
          .select({ id: agentSandboxes.id })
          .from(agentSandboxes)
          .where(eq(agentSandboxes.organization_id, context.organizationId));
        for (const row of rows) {
          const deleted = await elizaSandboxService.deleteAgent(row.id, context.organizationId, {
            authorization: "account_deletion",
          });
          if (!deleted.success && deleted.error !== "Agent not found") {
            throw new Error(deleted.error || "Agent provider deletion failed");
          }
        }
      },
    },
    github_repositories: {
      async inspect(context) {
        const [row] = await dbWrite
          .select({ id: apps.id })
          .from(apps)
          .where(eq(apps.organization_id, context.organizationId))
          .limit(1);
        return row ? { state: "needs_execution" } : complete(context, "github_repositories");
      },
      async execute(context) {
        const rows = await dbWrite
          .select({ id: apps.id })
          .from(apps)
          .where(eq(apps.organization_id, context.organizationId));
        for (const row of rows) {
          const deleted = await deleteAppWithCleanup(row.id, {
            continueOnError: false,
            deleteGitHubRepo: true,
            requireContainerTeardownCompletion: true,
          });
          if (!deleted.success) throw new Error(deleted.errors.join("; "));
        }
      },
    },
    connector_credentials: {
      async inspect(context) {
        const connections = await oauthService.listConnections({
          organizationId: context.organizationId,
        });
        return connections.length === 0
          ? complete(context, "connector_credentials")
          : { state: "needs_execution" };
      },
      async execute(context) {
        const connections = await oauthService.listConnections({
          organizationId: context.organizationId,
        });
        for (const connection of connections) {
          await oauthService.revokeConnection({
            organizationId: context.organizationId,
            connectionId: connection.id,
          });
        }
      },
    },
    voice_credentials: {
      async inspect(context) {
        const [row] = await dbWrite
          .select({ id: userVoices.id })
          .from(userVoices)
          .where(
            and(
              eq(userVoices.organizationId, context.organizationId),
              eq(userVoices.isActive, true),
            ),
          )
          .limit(1);
        return row ? { state: "needs_execution" } : complete(context, "voice_credentials");
      },
      async execute(context) {
        const rows = await dbWrite
          .select({ id: userVoices.id })
          .from(userVoices)
          .where(
            and(
              eq(userVoices.organizationId, context.organizationId),
              eq(userVoices.isActive, true),
            ),
          );
        for (const row of rows) {
          await voiceCloningService.deleteVoice(row.id, context.organizationId);
        }
      },
    },
    primary_object_storage: {
      async inspect(context) {
        const keys = await listOrganizationObjectKeys(context.blob, context.organizationId);
        if (keys.length > 0) return { state: "needs_execution" };
        const [row] = await dbWrite
          .select({ id: orgStorageObjects.id })
          .from(orgStorageObjects)
          .where(eq(orgStorageObjects.organization_id, context.organizationId))
          .limit(1);
        if (row) {
          await dbWrite.transaction(async (tx) => {
            await tx
              .delete(orgStorageReadOperations)
              .where(eq(orgStorageReadOperations.organization_id, context.organizationId));
            await tx
              .delete(orgStorageDeleteOperations)
              .where(eq(orgStorageDeleteOperations.organization_id, context.organizationId));
            await tx
              .delete(orgStorageGcOutbox)
              .where(eq(orgStorageGcOutbox.organization_id, context.organizationId));
            await tx
              .delete(orgStoragePutOperations)
              .where(eq(orgStoragePutOperations.organization_id, context.organizationId));
            await tx
              .delete(orgStorageObjects)
              .where(eq(orgStorageObjects.organization_id, context.organizationId));
          });
        }
        return complete(context, "primary_object_storage");
      },
      async execute(context) {
        for (const key of await listOrganizationObjectKeys(context.blob, context.organizationId)) {
          await context.blob.delete(key);
        }
      },
    },
    vault_key_bindings: {
      async inspect(context) {
        return (await vaultRowsRemain(context.organizationId))
          ? { state: "needs_execution" }
          : complete(context, "vault_key_bindings");
      },
      async execute(context) {
        await clearVaultKeyGraph(context.organizationId);
      },
    },
    other_grants: {
      async inspect(context) {
        const rows = await dbWrite.execute(sql<{ count: number }>`
          SELECT (
            (SELECT count(*) FROM affiliate_payout_outbox WHERE affiliate_user_id = ${context.userId}) +
            (SELECT count(*) FROM agent_billing_records WHERE organization_id = ${context.organizationId}) +
            (SELECT count(*) FROM container_billing_records WHERE organization_id = ${context.organizationId}) +
            (SELECT count(*) FROM stripe_checkout_orders WHERE organization_id = ${context.organizationId})
          )::int AS count
        `);
        const count = Number(rows.rows[0]?.count ?? 0);
        return count === 0 ? complete(context, "other_grants") : { state: "needs_execution" };
      },
      async execute(context) {
        await deleteLocalRestrictiveRows(context);
      },
    },
    steward_deletion: {
      async inspect(context) {
        const state = await inspectStewardPlatformUser(context.stewardUserId);
        return state === "absent"
          ? complete(context, "steward_deletion")
          : { state: "needs_execution" };
      },
      async execute(context) {
        await deleteStewardPlatformUser(context.stewardUserId);
      },
    },
  } satisfies Record<AccountDeletionProviderPhase, AccountDeletionProviderAdapter>;

  for (const adapter of Object.values(adapters)) {
    const inspect = adapter.inspect.bind(adapter);
    adapter.inspect = async (context) => {
      const inspection = await inspect(context);
      if (inspection.state === "complete" && !DIGEST_PATTERN.test(inspection.receiptDigest)) {
        throw new Error("Account deletion provider adapter emitted an invalid digest");
      }
      return inspection;
    };
  }
  return adapters;
}
