/**
 * Builds a read-only inventory of legacy identity sources before canonical
 * claim backfill. It reports incompatible IDs and ambiguous account scope
 * rather than coercing or mutating source records.
 */

import type {
  IdentityMigrationInventory,
  IdentityMigrationInventoryRow,
  JsonObject,
  UUID,
} from "@elizaos/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { eq, inArray, sql } from "drizzle-orm";
import { authOwnerBindingTable } from "../schema/authOwnerBinding";
import { connectorAccountsTable } from "../schema/connectorAccounts";
import { entityTable } from "../schema/entity";
import { entityIdentityTable } from "../schema/entityIdentity";
import { relationshipTable } from "../schema/relationship";
import type { DrizzleDatabase } from "../types";

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Inventory digest input must be JSON.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function computeIdentityMigrationInventoryDigest(
  agentId: UUID,
  sources: Readonly<Record<string, number>>,
  rows: readonly IdentityMigrationInventoryRow[]
): string {
  const bytes = sha256(
    new TextEncoder().encode(
      `elizaos:identity:migration-inventory:v1\n${stableJson({ agentId, sources, rows })}`
    )
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sortRows(rows: IdentityMigrationInventoryRow[]): IdentityMigrationInventoryRow[] {
  return rows.sort((left, right) =>
    [left.source, left.sourceId, left.principalReference ?? ""]
      .join("\0")
      .localeCompare([right.source, right.sourceId, right.principalReference ?? ""].join("\0"))
  );
}

function resultRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (typeof value === "object" && value !== null) {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

async function tableExists(db: DrizzleDatabase, schema: string, table: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 AS present
      FROM information_schema.tables
     WHERE table_schema = ${schema}
       AND table_name = ${table}
     LIMIT 1
  `);
  return resultRows(result).length > 0;
}

function asMetadata(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** Inspect all currently maintained identity sources without performing writes. */
export async function inspectSqlIdentityMigration(
  db: DrizzleDatabase,
  agentId: UUID,
  now: Date = new Date()
): Promise<IdentityMigrationInventory> {
  const rows: IdentityMigrationInventoryRow[] = [];
  const sources: Record<string, number> = {
    auth_owner_bindings: 0,
    connector_accounts: 0,
    entity_identities: 0,
    entity_metadata_platform_identities: 0,
    life_entity_identities: 0,
    relationships_identity_link: 0,
    trust_identity_links: 0,
  };

  const accounts = await db
    .select()
    .from(connectorAccountsTable)
    .where(eq(connectorAccountsTable.agentId, agentId));
  sources.connector_accounts = accounts.length;
  const activeAccounts = accounts.filter(
    (account) => account.deletedAt === null && account.status === "connected"
  );
  const accountsByProvider = new Map<string, typeof activeAccounts>();
  for (const account of accounts) {
    const provider = account.provider.trim().toLowerCase();
    if (account.deletedAt === null && account.status === "connected") {
      const current = accountsByProvider.get(provider) ?? [];
      current.push(account);
      accountsByProvider.set(provider, current);
    }
    const available = account.deletedAt === null && account.status === "connected";
    rows.push({
      source: "connector_accounts",
      sourceId: account.id,
      principalReference: null,
      connectorId: provider,
      connectorAccountReference: account.id,
      externalSubjectReference: account.externalId,
      disposition: !available ? "conflict" : account.externalId ? "review" : "needs_stable_subject",
      reasons: !available
        ? [account.deletedAt ? "connector_account_deleted" : "connector_account_disconnected"]
        : account.externalId
          ? ["transport_account_is_not_a_person_claim"]
          : ["connector_account_has_no_external_id"],
      metadata: { status: account.status, ownerBindingId: account.ownerBindingId },
    });
  }

  const ownerBindingIds = [
    ...new Set(accounts.map((account) => account.ownerBindingId).filter(Boolean)),
  ] as string[];
  if (ownerBindingIds.length > 0) {
    const bindings = await db
      .select()
      .from(authOwnerBindingTable)
      .where(inArray(authOwnerBindingTable.id, ownerBindingIds));
    for (const binding of bindings) {
      sources.auth_owner_bindings += 1;
      const matchingAccounts = accounts.filter((account) => account.ownerBindingId === binding.id);
      const validAccount = matchingAccounts.find(
        (account) =>
          account.deletedAt === null &&
          account.status === "connected" &&
          account.provider.trim().toLowerCase() === binding.connector.trim().toLowerCase()
      );
      rows.push({
        source: "auth_owner_bindings",
        sourceId: binding.id,
        principalReference: null,
        connectorId: binding.connector,
        connectorAccountReference: validAccount?.id ?? null,
        externalSubjectReference: binding.externalId,
        disposition: validAccount ? "needs_principal_projection" : "conflict",
        reasons: validAccount
          ? ["verified_binding_has_no_canonical_owner_principal_mapping"]
          : ["owner_binding_has_no_matching_connected_account"],
        metadata: { instanceId: binding.instanceId, verifiedAt: binding.verifiedAt },
      });
    }
  }

  const legacyIdentities = await db
    .select()
    .from(entityIdentityTable)
    .where(eq(entityIdentityTable.agentId, agentId));
  sources.entity_identities = legacyIdentities.length;
  const scopeOwners = new Map<string, Set<string>>();
  for (const identity of legacyIdentities) {
    const provider = identity.platform.trim().toLowerCase();
    const providerAccounts = accountsByProvider.get(provider) ?? [];
    const key = `${provider}\0${identity.handle}`;
    const owners = scopeOwners.get(key) ?? new Set<string>();
    owners.add(identity.entityId);
    scopeOwners.set(key, owners);
    const reasons = ["legacy_handle_requires_connector_subject_semantics"];
    let disposition: IdentityMigrationInventoryRow["disposition"] = "needs_stable_subject";
    if (providerAccounts.length !== 1) {
      disposition = "needs_connector_account";
      reasons.push(
        providerAccounts.length === 0 ? "no_connected_account" : "ambiguous_connected_account"
      );
    }
    rows.push({
      source: "entity_identities",
      sourceId: identity.id,
      principalReference: identity.entityId,
      connectorId: provider,
      connectorAccountReference:
        providerAccounts.length === 1 ? (providerAccounts[0]?.id ?? null) : null,
      externalSubjectReference: identity.handle,
      disposition,
      reasons,
      metadata: {
        verified: identity.verified,
        confidence: identity.confidence,
        source: identity.source,
      },
    });
  }
  for (const row of rows) {
    if (row.source !== "entity_identities" || row.connectorId === null) continue;
    const owners = scopeOwners.get(`${row.connectorId}\0${row.externalSubjectReference ?? ""}`);
    if (owners && owners.size > 1) {
      row.disposition = "conflict";
      row.reasons = [...row.reasons, "same_legacy_subject_on_multiple_principals"];
    }
  }

  const entities = await db
    .select({ id: entityTable.id, metadata: entityTable.metadata })
    .from(entityTable)
    .where(eq(entityTable.agentId, agentId));
  for (const entity of entities) {
    const metadata = asMetadata(entity.metadata);
    const candidates = Array.isArray(metadata.platformIdentities)
      ? metadata.platformIdentities
      : [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const record = asMetadata(candidate);
      sources.entity_metadata_platform_identities += 1;
      rows.push({
        source: "entity_metadata_platform_identities",
        sourceId: `${entity.id}:${index}`,
        principalReference: entity.id,
        connectorId: typeof record.platform === "string" ? record.platform : null,
        connectorAccountReference: null,
        externalSubjectReference: typeof record.handle === "string" ? record.handle : null,
        disposition: "review",
        reasons: ["unstructured_legacy_metadata_requires_normalization"],
        metadata: {},
      });
    }
  }

  const identityLinks = await db
    .select()
    .from(relationshipTable)
    .where(eq(relationshipTable.agentId, agentId));
  for (const relationship of identityLinks.filter(
    (relationship) =>
      relationship.tags?.includes("identity_link") &&
      asMetadata(relationship.metadata).status === "confirmed"
  )) {
    sources.relationships_identity_link += 1;
    rows.push({
      source: "relationships_identity_link",
      sourceId: relationship.id,
      principalReference: relationship.sourceEntityId,
      connectorId: null,
      connectorAccountReference: null,
      externalSubjectReference: relationship.targetEntityId,
      disposition: "review",
      reasons: ["confirmed_link_is_merge_evidence_not_a_scoped_claim"],
      metadata: { targetPrincipalId: relationship.targetEntityId },
    });
  }

  if (
    (await tableExists(db, "app_lifeops", "life_entities")) &&
    (await tableExists(db, "app_lifeops", "life_entity_identities"))
  ) {
    const result = await db.execute(sql`
      SELECT i.id, i.entity_id, i.platform, i.handle, i.connector_account_id,
             i.verified, i.confidence
        FROM app_lifeops.life_entity_identities i
       WHERE i.agent_id = ${agentId}
       ORDER BY i.id
    `);
    for (const record of resultRows(result)) {
      const sourceId = String(record.id ?? "");
      const principal = String(record.entity_id ?? "");
      const account = String(record.connector_account_id ?? "");
      sources.life_entity_identities += 1;
      const reasons: string[] = [];
      if (!isUuid(principal)) reasons.push("lifeops_principal_is_not_uuid");
      if (!isUuid(account)) reasons.push("lifeops_connector_account_is_not_uuid");
      rows.push({
        source: "life_entity_identities",
        sourceId,
        principalReference: principal,
        connectorId: String(record.platform ?? "") || null,
        connectorAccountReference: account || null,
        externalSubjectReference: String(record.handle ?? "") || null,
        disposition: !isUuid(principal)
          ? "needs_principal_projection"
          : !isUuid(account)
            ? "needs_connector_account"
            : "review",
        reasons: reasons.length > 0 ? reasons : ["legacy_claim_requires_subject_semantics_review"],
        metadata: {
          verified: record.verified === true,
          confidence: typeof record.confidence === "number" ? record.confidence : 0,
        },
      });
    }
  }

  // trust.identity_links has no agent/tenant column. Reading it here would
  // cross tenant boundaries, so the inventory records the structural blocker.
  rows.push({
    source: "trust_identity_links",
    sourceId: "schema",
    principalReference: null,
    connectorId: null,
    connectorAccountReference: null,
    externalSubjectReference: null,
    disposition: "review",
    reasons: ["source_is_not_tenant_scoped_and_cannot_be_read_safely"],
    metadata: {},
  });

  const sortedRows = sortRows(rows);
  const sortedSources = Object.fromEntries(
    Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))
  );
  return {
    contractVersion: 1,
    agentId,
    generatedAt: now.toISOString(),
    digest: computeIdentityMigrationInventoryDigest(agentId, sortedSources, sortedRows),
    sources: sortedSources,
    rows: sortedRows,
  };
}
