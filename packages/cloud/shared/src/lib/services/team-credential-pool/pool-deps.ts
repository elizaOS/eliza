/**
 * Drizzle-backed AccountPoolDeps (#11332).
 *
 * The cloud account-pool brain is dependency-injected: give it `readAccounts`
 * / `writeAccount` / `deleteAccount` and every selection strategy, health
 * rule, and affinity behavior works against the `pooled_credentials` table for
 * ONE organization:
 *
 * - `readAccounts` is synchronous by contract (the self-host impl reads a
 *   local JSON file), so this deps object serves an in-memory snapshot that
 *   `refresh()` reloads from the DB. The registry refreshes before selection
 *   whenever the snapshot is older than its TTL.
 * - `writeAccount` is a ROW-LEVEL UPDATE of ONLY the columns the pool brain
 *   owns (health / health_detail / usage / last_used_at) — never a blob
 *   rewrite, and never the admin-owned columns (label / enabled / priority,
 *   which the PATCH route writes directly). The pool mutates from an
 *   in-memory snapshot that can be seconds stale; if it wrote `enabled` it
 *   would silently revert a concurrent admin disable.
 * - `deleteAccount` removes the row AND its vault secret.
 *
 * Raw key material never passes through this class — the pool brain selects
 * metadata records; callers resolve ciphertext via SecretsService at use time.
 */

import type { LinkedAccountConfig, LinkedAccountHealth } from "@elizaos/contracts";
import {
  type PooledCredential,
  pooledCredentialsRepository,
} from "../../../db/repositories/pooled-credentials";
import { logger } from "../../utils/logger";
import { secretsService } from "../secrets/secrets";
import type { AccountPoolDeps, PoolProviderId } from "./account-pool-contract";

function poolRecordKey(providerId: string, accountId: string): string {
  return `${providerId}:${accountId}`;
}

function rowToLinkedAccount(row: PooledCredential): LinkedAccountConfig {
  return {
    id: row.id,
    providerId: row.provider as LinkedAccountConfig["providerId"],
    label: row.label,
    source: "api-key",
    enabled: row.enabled,
    priority: row.priority,
    createdAt: row.created_at.getTime(),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at.getTime() } : {}),
    health: row.health as LinkedAccountHealth,
    ...(row.health_detail ? { healthDetail: row.health_detail } : {}),
    ...(row.usage ? { usage: row.usage } : {}),
    organizationId: row.organization_id,
    ...(row.contributed_by ? { userId: row.contributed_by } : {}),
  };
}

export class DrizzleAccountPoolDeps implements AccountPoolDeps {
  private snapshot: Record<string, LinkedAccountConfig> = {};
  private rowsById = new Map<string, PooledCredential>();
  private loadedAt = 0;

  constructor(readonly organizationId: string) {}

  /** Reload the org's credential rows into the in-memory snapshot. */
  async refresh(): Promise<void> {
    const rows = await pooledCredentialsRepository.listByOrganization(this.organizationId);
    const snapshot: Record<string, LinkedAccountConfig> = {};
    const rowsById = new Map<string, PooledCredential>();
    for (const row of rows) {
      snapshot[poolRecordKey(row.provider, row.id)] = rowToLinkedAccount(row);
      rowsById.set(row.id, row);
    }
    this.snapshot = snapshot;
    this.rowsById = rowsById;
    this.loadedAt = Date.now();
  }

  isStale(ttlMs: number): boolean {
    return Date.now() - this.loadedAt > ttlMs;
  }

  /** Secret id backing a credential (for use-time ciphertext resolution). */
  secretIdFor(credentialId: string): string | null {
    return this.rowsById.get(credentialId)?.secret_id ?? null;
  }

  readAccounts(): Record<string, LinkedAccountConfig> {
    return this.snapshot;
  }

  async writeAccount(account: LinkedAccountConfig): Promise<void> {
    // Pool-owned columns ONLY. The pool spreads `...account` from a snapshot
    // that may be stale; persisting label/enabled/priority here would clobber
    // a concurrent admin PATCH (e.g. re-enable a just-disabled credential).
    const updated = await pooledCredentialsRepository.updatePoolStateForOrganization(
      account.id,
      this.organizationId,
      {
        health: account.health,
        health_detail: account.healthDetail ?? null,
        usage: account.usage ?? null,
        last_used_at: account.lastUsedAt ? new Date(account.lastUsedAt) : null,
      },
    );
    if (!updated) {
      // Row deleted underneath us (e.g. contributor removed it) — drop it
      // from the snapshot instead of resurrecting stale state.
      delete this.snapshot[poolRecordKey(account.providerId, account.id)];
      this.rowsById.delete(account.id);
      return;
    }
    this.snapshot[poolRecordKey(updated.provider, updated.id)] = rowToLinkedAccount(updated);
    this.rowsById.set(updated.id, updated);
  }

  async deleteAccount(providerId: PoolProviderId, accountId: string): Promise<void> {
    const row =
      this.rowsById.get(accountId) ??
      (await pooledCredentialsRepository.findByIdForOrganization(accountId, this.organizationId));
    const deleted = await pooledCredentialsRepository.deleteForOrganization(
      accountId,
      this.organizationId,
    );
    delete this.snapshot[poolRecordKey(providerId, accountId)];
    this.rowsById.delete(accountId);
    const secretId = row?.secret_id;
    if (!deleted || !secretId) return;
    try {
      await secretsService.delete(secretId, this.organizationId, {
        actorType: "system",
        actorId: "team-credential-pool",
        source: "team-credential-pool",
      });
    } catch (err) {
      // error-policy:J6 best-effort teardown — the authoritative pool-row
      // delete already succeeded, so the credential can never be selected
      // again; an orphaned vault secret is a GC concern (warned, not fatal),
      // not a failure of the removal. A DB delete failure above still throws.
      logger.warn("[DrizzleAccountPoolDeps] secret cleanup failed after credential delete", {
        organizationId: this.organizationId,
        credentialId: accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
