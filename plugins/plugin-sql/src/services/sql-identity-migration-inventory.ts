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
import { eq, inArray, or, sql } from "drizzle-orm";
import { authOwnerBindingTable } from "../schema/authOwnerBinding";
import { connectorAccountsTable } from "../schema/connectorAccounts";
import { entityTable } from "../schema/entity";
import { identityClaimTable } from "../schema/identityAuthority";
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
  now: Date = new Date(),
  instanceId?: string
): Promise<IdentityMigrationInventory> {
  const rows: IdentityMigrationInventoryRow[] = [];
  const sources: Record<string, number> = {
    auth_owner_bindings: 0,
    connector_accounts: 0,
    identity_claims: 0,
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
  if (ownerBindingIds.length > 0 || instanceId) {
    const ownerBindingScope =
      ownerBindingIds.length > 0 && instanceId
        ? or(
            inArray(authOwnerBindingTable.id, ownerBindingIds),
            eq(authOwnerBindingTable.instanceId, instanceId)
          )
        : ownerBindingIds.length > 0
          ? inArray(authOwnerBindingTable.id, ownerBindingIds)
          : eq(authOwnerBindingTable.instanceId, instanceId as string);
    const bindings = await db.select().from(authOwnerBindingTable).where(ownerBindingScope);
    const bindingsById = new Map(bindings.map((binding) => [binding.id, binding]));
    for (const binding of bindings) {
      sources.auth_owner_bindings += 1;
      const matchingAccounts = accounts.filter((account) => account.ownerBindingId === binding.id);
      const validAccounts = matchingAccounts.filter(
        (account) =>
          account.deletedAt === null &&
          account.status === "connected" &&
          account.provider.trim().toLowerCase() === binding.connector.trim().toLowerCase() &&
          account.externalId === binding.externalId &&
          account.ownerIdentityId === binding.identityId &&
          binding.verifiedAt > 0 &&
          (!instanceId || binding.instanceId === instanceId)
      );
      const validAccount = validAccounts.length === 1 ? validAccounts[0] : null;
      const reasons: string[] = [];
      if (instanceId && binding.instanceId !== instanceId)
        reasons.push("owner_binding_wrong_instance");
      if (binding.verifiedAt <= 0) reasons.push("owner_binding_unverified");
      if (matchingAccounts.length === 0) {
        reasons.push("orphan_owner_binding_has_no_connector_account");
      } else {
        if (
          matchingAccounts.every(
            (account) => account.deletedAt !== null || account.status !== "connected"
          )
        ) {
          reasons.push("owner_binding_connector_account_disconnected");
        }
        if (
          matchingAccounts.some(
            (account) =>
              account.provider.trim().toLowerCase() !== binding.connector.trim().toLowerCase()
          )
        ) {
          reasons.push("owner_binding_connector_mismatch");
        }
        if (matchingAccounts.some((account) => account.externalId !== binding.externalId)) {
          reasons.push("owner_binding_external_subject_mismatch");
        }
        if (matchingAccounts.some((account) => account.ownerIdentityId !== binding.identityId)) {
          reasons.push("owner_binding_identity_mismatch");
        }
      }
      if (validAccounts.length > 1) {
        reasons.push("owner_binding_has_multiple_matching_connected_accounts");
      }
      if (validAccount) {
        reasons.push("verified_binding_has_no_canonical_owner_principal_mapping");
      }
      rows.push({
        source: "auth_owner_bindings",
        sourceId: binding.id,
        principalReference: null,
        connectorId: binding.connector,
        connectorAccountReference: validAccount?.id ?? null,
        externalSubjectReference: binding.externalId,
        disposition: validAccount ? "needs_principal_projection" : "conflict",
        reasons: reasons.length > 0 ? reasons : ["owner_binding_has_no_matching_connected_account"],
        metadata: { instanceId: binding.instanceId, verifiedAt: binding.verifiedAt },
      });
    }
    for (const row of rows) {
      if (row.source !== "connector_accounts") continue;
      const ownerBindingId =
        typeof row.metadata.ownerBindingId === "string" ? row.metadata.ownerBindingId : null;
      if (!ownerBindingId) continue;
      const binding = bindingsById.get(ownerBindingId);
      if (!binding) {
        row.disposition = "conflict";
        row.reasons = [...row.reasons, "connector_account_owner_binding_missing"];
      } else if (
        binding.instanceId !== instanceId ||
        binding.externalId !== row.externalSubjectReference ||
        binding.connector.trim().toLowerCase() !== row.connectorId ||
        binding.verifiedAt <= 0 ||
        accounts.find((account) => account.id === row.connectorAccountReference)
          ?.ownerIdentityId !== binding.identityId
      ) {
        row.disposition = "conflict";
        row.reasons = [...row.reasons, "connector_account_owner_binding_invalid"];
      }
    }
  }

  const canonicalClaims = await db
    .select()
    .from(identityClaimTable)
    .where(eq(identityClaimTable.agentId, agentId));
  sources.identity_claims = canonicalClaims.length;
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  for (const claim of canonicalClaims) {
    const account = accountsById.get(claim.connectorAccountId);
    const reasons: string[] = [];
    if (!account) reasons.push("canonical_claim_connector_account_missing");
    else {
      if (account.deletedAt !== null) reasons.push("canonical_claim_connector_account_deleted");
      if (account.status !== "connected")
        reasons.push("canonical_claim_connector_account_disconnected");
      if (account.provider.trim().toLowerCase() !== claim.connectorId.trim().toLowerCase()) {
        reasons.push("canonical_claim_connector_mismatch");
      }
    }
    if (claim.verification === "verified" || claim.verification === "owner_bound") {
      reasons.push("canonical_claim_verification_authority_unavailable");
    }
    rows.push({
      source: "identity_claims",
      sourceId: claim.id,
      principalReference: claim.principalEntityId,
      connectorId: claim.connectorId,
      connectorAccountReference: claim.connectorAccountId,
      externalSubjectReference: claim.externalSubjectId,
      disposition: reasons.length > 0 ? "conflict" : "review",
      reasons: reasons.length > 0 ? reasons : ["canonical_claim_requires_authority_review"],
      metadata: { status: claim.status, verification: claim.verification },
    });
  }
  if (!instanceId) {
    rows.push({
      source: "auth_owner_bindings",
      sourceId: "unscoped-orphans",
      principalReference: null,
      connectorId: null,
      connectorAccountReference: null,
      externalSubjectReference: null,
      disposition: "review",
      reasons: ["instance_id_unavailable_for_orphan_owner_binding_inventory"],
      metadata: {},
    });
  }

  const legacyIdentityResult = await db.execute(sql`
    SELECT i.*, e.agent_id AS entity_agent_id
      FROM entity_identities i
      LEFT JOIN entities e ON e.id = i.entity_id
     WHERE i.agent_id = ${agentId} OR e.agent_id = ${agentId}
     ORDER BY i.id
  `);
  const legacyIdentities = resultRows(legacyIdentityResult);
  sources.entity_identities = legacyIdentities.length;
  const scopeOwners = new Map<string, Set<string>>();
  for (const identity of legacyIdentities) {
    const identityAgentId = String(identity.agent_id ?? "");
    const entityAgentId =
      identity.entity_agent_id == null ? null : String(identity.entity_agent_id);
    const entityId = String(identity.entity_id ?? "");
    const handle = String(identity.handle ?? "");
    const provider = String(identity.platform ?? "")
      .trim()
      .toLowerCase();
    const providerAccounts = accountsByProvider.get(provider) ?? [];
    const key = `${provider}\0${handle}`;
    const owners = scopeOwners.get(key) ?? new Set<string>();
    owners.add(entityId);
    scopeOwners.set(key, owners);
    const reasons = ["legacy_handle_requires_connector_subject_semantics"];
    if (entityAgentId === null) reasons.push("legacy_identity_entity_missing");
    if (identityAgentId !== agentId || entityAgentId !== agentId) {
      reasons.push("legacy_identity_agent_entity_tenant_mismatch");
    }
    let disposition: IdentityMigrationInventoryRow["disposition"] = "needs_stable_subject";
    if (providerAccounts.length !== 1) {
      disposition = "needs_connector_account";
      reasons.push(
        providerAccounts.length === 0 ? "no_connected_account" : "ambiguous_connected_account"
      );
    }
    if (identityAgentId !== agentId || entityAgentId !== agentId) disposition = "conflict";
    rows.push({
      source: "entity_identities",
      sourceId: String(identity.id ?? ""),
      principalReference: entityId,
      connectorId: provider,
      connectorAccountReference:
        providerAccounts.length === 1 ? (providerAccounts[0]?.id ?? null) : null,
      externalSubjectReference: handle,
      disposition,
      reasons,
      metadata: {
        verified: identity.verified === true,
        confidence: typeof identity.confidence === "number" ? identity.confidence : 0,
        source: typeof identity.source === "string" ? identity.source : null,
        identityAgentId,
        entityAgentId,
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

  const relationshipResult = await db.execute(sql`
    SELECT r.*, source.agent_id AS source_agent_id, target.agent_id AS target_agent_id
      FROM relationships r
      LEFT JOIN entities source ON source.id = r.source_entity_id
      LEFT JOIN entities target ON target.id = r.target_entity_id
     WHERE r.agent_id = ${agentId}
        OR source.agent_id = ${agentId}
        OR target.agent_id = ${agentId}
     ORDER BY r.id
  `);
  for (const relationship of resultRows(relationshipResult).filter((record) => {
    const tags = Array.isArray(record.tags) ? record.tags : [];
    return tags.includes("identity_link") && asMetadata(record.metadata).status === "confirmed";
  })) {
    sources.relationships_identity_link += 1;
    const relationshipAgentId = String(relationship.agent_id ?? "");
    const sourceAgentId =
      relationship.source_agent_id == null ? null : String(relationship.source_agent_id);
    const targetAgentId =
      relationship.target_agent_id == null ? null : String(relationship.target_agent_id);
    const tenantMismatch =
      relationshipAgentId !== agentId || sourceAgentId !== agentId || targetAgentId !== agentId;
    rows.push({
      source: "relationships_identity_link",
      sourceId: String(relationship.id ?? ""),
      principalReference: String(relationship.source_entity_id ?? ""),
      connectorId: null,
      connectorAccountReference: null,
      externalSubjectReference: String(relationship.target_entity_id ?? ""),
      disposition: tenantMismatch ? "conflict" : "review",
      reasons: tenantMismatch
        ? ["relationship_identity_link_cross_tenant"]
        : ["confirmed_link_is_merge_evidence_not_a_scoped_claim"],
      metadata: {
        targetPrincipalId: String(relationship.target_entity_id ?? ""),
        relationshipAgentId,
        sourceAgentId,
        targetAgentId,
      },
    });
  }

  if (
    (await tableExists(db, "app_lifeops", "life_entities")) &&
    (await tableExists(db, "app_lifeops", "life_entity_identities"))
  ) {
    const result = await db.execute(sql`
      SELECT i.id, i.agent_id AS life_agent_id, i.entity_id, i.platform, i.handle, i.connector_account_id,
             i.verified, i.confidence, e.entity_id AS declared_entity_id,
             principal.agent_id AS principal_agent_id,
             account.agent_id AS account_agent_id,
             account.provider AS account_provider,
             account.status AS account_status,
             account.deleted_at AS account_deleted_at
        FROM app_lifeops.life_entity_identities i
        LEFT JOIN app_lifeops.life_entities e
         ON e.entity_id = i.entity_id
         AND e.agent_id = i.agent_id
        LEFT JOIN entities principal ON principal.id::text = i.entity_id::text
        LEFT JOIN connector_accounts account ON account.id::text = i.connector_account_id::text
       WHERE i.agent_id = ${agentId}
          OR principal.agent_id = ${agentId}
          OR account.agent_id = ${agentId}
       ORDER BY i.id
    `);
    for (const record of resultRows(result)) {
      const sourceId = String(record.id ?? "");
      const principal = String(record.entity_id ?? "");
      const account = String(record.connector_account_id ?? "");
      sources.life_entity_identities += 1;
      const reasons: string[] = [];
      if (String(record.life_agent_id ?? "") !== agentId) {
        reasons.push("lifeops_identity_wrong_tenant");
      }
      if (record.declared_entity_id === null || record.declared_entity_id === undefined) {
        reasons.push("lifeops_entity_missing");
      }
      if (!isUuid(principal)) reasons.push("lifeops_principal_is_not_uuid");
      if (!isUuid(account)) reasons.push("lifeops_connector_account_is_not_uuid");
      if (isUuid(principal) && record.principal_agent_id == null) {
        reasons.push("lifeops_canonical_principal_missing");
      } else if (isUuid(principal) && String(record.principal_agent_id) !== agentId) {
        reasons.push("lifeops_canonical_principal_wrong_tenant");
      }
      if (isUuid(account) && record.account_agent_id == null) {
        reasons.push("lifeops_connector_account_missing");
      } else if (isUuid(account)) {
        if (String(record.account_agent_id) !== agentId)
          reasons.push("lifeops_connector_account_wrong_tenant");
        if (
          String(record.account_provider ?? "")
            .trim()
            .toLowerCase() !==
          String(record.platform ?? "")
            .trim()
            .toLowerCase()
        )
          reasons.push("lifeops_connector_account_provider_mismatch");
        if (record.account_status !== "connected" || record.account_deleted_at != null)
          reasons.push("lifeops_connector_account_not_live");
      }
      rows.push({
        source: "life_entity_identities",
        sourceId,
        principalReference: principal,
        connectorId: String(record.platform ?? "") || null,
        connectorAccountReference: account || null,
        externalSubjectReference: String(record.handle ?? "") || null,
        disposition: reasons.some(
          (reason) =>
            reason.includes("wrong_tenant") ||
            reason.includes("missing") ||
            reason.includes("mismatch") ||
            reason.includes("not_live")
        )
          ? "conflict"
          : !isUuid(principal)
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

  const subjectRows = new Map<string, IdentityMigrationInventoryRow[]>();
  for (const row of rows) {
    if (!row.connectorId || !row.externalSubjectReference) continue;
    const key = `${row.connectorId.trim().toLowerCase()}\0${row.connectorAccountReference ?? "unscoped"}\0${row.externalSubjectReference}`;
    const matches = subjectRows.get(key) ?? [];
    matches.push(row);
    subjectRows.set(key, matches);
  }
  for (const matches of subjectRows.values()) {
    const sourcesForSubject = new Set(matches.map((row) => row.source));
    const principals = new Set(
      matches
        .map((row) => row.principalReference)
        .filter((value): value is string => Boolean(value))
    );
    if (principals.size > 1) {
      for (const row of matches) {
        row.disposition = "conflict";
        if (!row.reasons.includes("same_subject_on_multiple_declared_principals")) {
          row.reasons = [...row.reasons, "same_subject_on_multiple_declared_principals"];
        }
      }
    } else if (sourcesForSubject.size > 1) {
      for (const row of matches) {
        if (!row.reasons.includes("duplicate_subject_across_declared_sources")) {
          row.reasons = [...row.reasons, "duplicate_subject_across_declared_sources"];
        }
      }
    }
  }

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
