/** Immutable node, activation, vault-seed, and final restore receipt authorities. */

import type { InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agentBackupRestoreLeases } from "./agent-backup-catalog";
import { agentNodeIncarnationHistories } from "./agent-node-incarnation-histories";
import {
  type AgentActivationPurpose,
  type AgentActivationReceipt,
  agentSandboxBackups,
} from "./agent-sandboxes";
import { agentVaultKeyBackupBindings } from "./agent-vault-key-authority";
import { organizations } from "./organizations";

export type { AgentNodeIncarnationHistory } from "./agent-node-incarnation-histories";
export { agentNodeIncarnationHistories };

export const agentActivationPublications = pgTable(
  "agent_activation_publications",
  {
    id: uuid("id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    activation_generation: uuid("activation_generation").notNull(),
    previous_activation_generation: uuid("previous_activation_generation"),
    lifecycle_revision: numeric("lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    purpose: text("purpose").$type<AgentActivationPurpose>().notNull(),
    backup_id: uuid("backup_id"),
    backup_manifest_sha256: text("backup_manifest_sha256"),
    activation_receipt: jsonb("activation_receipt").$type<AgentActivationReceipt>().notNull(),
    activation_receipt_sha256: text("activation_receipt_sha256").notNull(),
    container_id: text("container_id").notNull(),
    node_history_id: uuid("node_history_id").notNull(),
    docker_node_record_id: uuid("docker_node_record_id").notNull(),
    node_id: text("node_id").notNull(),
    node_incarnation: uuid("node_incarnation").notNull(),
    image_digest: text("image_digest").notNull(),
    token_sha256: text("token_sha256").notNull(),
    funding_revision: bigint("funding_revision", { mode: "bigint" }).notNull(),
    published_at: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activation_unique: unique("agent_activation_publications_activation_unique").on(
      table.organization_id,
      table.agent_id,
      table.activation_generation,
    ),
    receipt_authority_unique: unique("agent_activation_publications_receipt_authority_unique").on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.activation_generation,
      table.purpose,
      table.backup_id,
      table.backup_manifest_sha256,
      table.activation_receipt_sha256,
    ),
    node_history_fk: foreignKey({
      name: "agent_activation_publications_node_history_fkey",
      columns: [table.node_history_id, table.docker_node_record_id, table.node_incarnation],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
      ],
    }).onDelete("restrict"),
    backup_authority_fk: foreignKey({
      name: "agent_activation_publications_backup_authority_fkey",
      columns: [
        table.backup_id,
        table.organization_id,
        table.agent_id,
        table.backup_manifest_sha256,
      ],
      foreignColumns: [
        agentSandboxBackups.id,
        agentSandboxBackups.catalog_organization_id,
        agentSandboxBackups.catalog_agent_id,
        agentSandboxBackups.manifest_digest,
      ],
    }).onDelete("restrict"),
    shape_check: check(
      "agent_activation_publications_shape_check",
      sql`(${table.lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.purpose} IN ('provision', 'wake', 'restore', 'fresh_boot')
        AND ((${table.backup_id} IS NULL AND ${table.backup_manifest_sha256} IS NULL
          AND ${table.purpose} <> 'restore') OR (${table.backup_id} IS NOT NULL
          AND ${table.backup_manifest_sha256} ~ '^[0-9a-f]{64}$'))
        AND ${table.activation_receipt_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.container_id} ~ '^[0-9a-f]{64}$'
        AND ${table.image_digest} ~ '^sha256:[0-9a-f]{64}$'
        AND ${table.token_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.funding_revision} >= 0) IS TRUE`,
    ),
  }),
);

export const agentVaultKeySeedReceipts = pgTable(
  "agent_vault_key_seed_receipts",
  {
    id: uuid("id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    lease_id: uuid("lease_id").notNull(),
    lease_owner_id: text("lease_owner_id").notNull(),
    lease_fencing_token: uuid("lease_fencing_token").notNull(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    backup_id: uuid("backup_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    source_activation_generation: uuid("source_activation_generation").notNull(),
    source_lifecycle_revision: numeric("source_lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    manifest_sha256: text("manifest_sha256").notNull(),
    vault_key_generation_id: uuid("vault_key_generation_id").notNull(),
    vault_key_authority_receipt_digest: text("vault_key_authority_receipt_digest").notNull(),
    target_activation_generation: uuid("target_activation_generation").notNull(),
    node_history_id: uuid("node_history_id").notNull(),
    docker_node_record_id: uuid("docker_node_record_id").notNull(),
    node_incarnation: uuid("node_incarnation").notNull(),
    receipt_digest: text("receipt_digest").notNull(),
    seeded_at: timestamp("seeded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt_unique: unique("agent_vault_key_seed_receipts_attempt_unique").on(
      table.organization_id,
      table.restore_attempt_id,
    ),
    receipt_authority_unique: unique("agent_vault_key_seed_receipts_receipt_authority_unique").on(
      table.id,
      table.organization_id,
      table.agent_id,
      table.restore_attempt_id,
      table.backup_id,
      table.operation_id,
      table.source_activation_generation,
      table.source_lifecycle_revision,
      table.manifest_sha256,
      table.target_activation_generation,
      table.receipt_digest,
    ),
    lease_authority_fk: foreignKey({
      name: "agent_vault_key_seed_receipts_lease_authority_fkey",
      columns: [
        table.lease_id,
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.restore_attempt_id,
        table.lease_owner_id,
        table.lease_fencing_token,
      ],
      foreignColumns: [
        agentBackupRestoreLeases.id,
        agentBackupRestoreLeases.organization_id,
        agentBackupRestoreLeases.agent_id,
        agentBackupRestoreLeases.backup_id,
        agentBackupRestoreLeases.restore_attempt_id,
        agentBackupRestoreLeases.owner_id,
        agentBackupRestoreLeases.generation,
      ],
    }).onDelete("restrict"),
    vault_binding_fk: foreignKey({
      name: "agent_vault_key_seed_receipts_vault_binding_fkey",
      columns: [
        table.organization_id,
        table.agent_id,
        table.backup_id,
        table.operation_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
        table.manifest_sha256,
        table.vault_key_generation_id,
        table.vault_key_authority_receipt_digest,
      ],
      foreignColumns: [
        agentVaultKeyBackupBindings.organization_id,
        agentVaultKeyBackupBindings.agent_id,
        agentVaultKeyBackupBindings.backup_id,
        agentVaultKeyBackupBindings.operation_id,
        agentVaultKeyBackupBindings.source_activation_generation,
        agentVaultKeyBackupBindings.source_lifecycle_revision,
        agentVaultKeyBackupBindings.manifest_sha256,
        agentVaultKeyBackupBindings.vault_key_generation_id,
        agentVaultKeyBackupBindings.vault_key_authority_receipt_digest,
      ],
    }).onDelete("restrict"),
    node_history_fk: foreignKey({
      name: "agent_vault_key_seed_receipts_node_history_fkey",
      columns: [table.node_history_id, table.docker_node_record_id, table.node_incarnation],
      foreignColumns: [
        agentNodeIncarnationHistories.id,
        agentNodeIncarnationHistories.docker_node_record_id,
        agentNodeIncarnationHistories.node_incarnation,
      ],
    }).onDelete("restrict"),
    shape_check: check(
      "agent_vault_key_seed_receipts_shape_check",
      sql`(${table.source_lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.vault_key_authority_receipt_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.receipt_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.lease_owner_id} = btrim(${table.lease_owner_id})
        AND octet_length(${table.lease_owner_id}) BETWEEN 1 AND 255) IS TRUE`,
    ),
  }),
);

export const agentBackupRestoreReceipts = pgTable(
  "agent_backup_restore_receipts",
  {
    id: uuid("id").primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    restore_attempt_id: uuid("restore_attempt_id").notNull(),
    backup_id: uuid("backup_id").notNull(),
    operation_id: uuid("operation_id").notNull(),
    source_activation_generation: uuid("source_activation_generation").notNull(),
    source_lifecycle_revision: numeric("source_lifecycle_revision", {
      precision: 20,
      scale: 0,
      mode: "bigint",
    }).notNull(),
    manifest_sha256: text("manifest_sha256").notNull(),
    seed_receipt_id: uuid("seed_receipt_id").notNull(),
    seed_receipt_digest: text("seed_receipt_digest").notNull(),
    target_activation_generation: uuid("target_activation_generation").notNull(),
    activation_purpose: text("activation_purpose").$type<AgentActivationPurpose>().notNull(),
    activation_publication_id: uuid("activation_publication_id").notNull(),
    activation_receipt_sha256: text("activation_receipt_sha256").notNull(),
    restore_generation: bigint("restore_generation", { mode: "bigint" }).notNull(),
    receipt_digest: text("receipt_digest").notNull(),
    verified_at: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attempt_unique: unique("agent_backup_restore_receipts_attempt_unique").on(
      table.organization_id,
      table.restore_attempt_id,
    ),
    seed_receipt_fk: foreignKey({
      name: "agent_backup_restore_receipts_seed_receipt_fkey",
      columns: [
        table.seed_receipt_id,
        table.organization_id,
        table.agent_id,
        table.restore_attempt_id,
        table.backup_id,
        table.operation_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
        table.manifest_sha256,
        table.target_activation_generation,
        table.seed_receipt_digest,
      ],
      foreignColumns: [
        agentVaultKeySeedReceipts.id,
        agentVaultKeySeedReceipts.organization_id,
        agentVaultKeySeedReceipts.agent_id,
        agentVaultKeySeedReceipts.restore_attempt_id,
        agentVaultKeySeedReceipts.backup_id,
        agentVaultKeySeedReceipts.operation_id,
        agentVaultKeySeedReceipts.source_activation_generation,
        agentVaultKeySeedReceipts.source_lifecycle_revision,
        agentVaultKeySeedReceipts.manifest_sha256,
        agentVaultKeySeedReceipts.target_activation_generation,
        agentVaultKeySeedReceipts.receipt_digest,
      ],
    }).onDelete("restrict"),
    activation_publication_fk: foreignKey({
      name: "agent_backup_restore_receipts_activation_publication_fkey",
      columns: [
        table.activation_publication_id,
        table.organization_id,
        table.agent_id,
        table.target_activation_generation,
        table.activation_purpose,
        table.backup_id,
        table.manifest_sha256,
        table.activation_receipt_sha256,
      ],
      foreignColumns: [
        agentActivationPublications.id,
        agentActivationPublications.organization_id,
        agentActivationPublications.agent_id,
        agentActivationPublications.activation_generation,
        agentActivationPublications.purpose,
        agentActivationPublications.backup_id,
        agentActivationPublications.backup_manifest_sha256,
        agentActivationPublications.activation_receipt_sha256,
      ],
    }).onDelete("restrict"),
    backup_authority_fk: foreignKey({
      name: "agent_backup_restore_receipts_backup_authority_fkey",
      columns: [
        table.backup_id,
        table.organization_id,
        table.agent_id,
        table.operation_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
        table.manifest_sha256,
      ],
      foreignColumns: [
        agentSandboxBackups.id,
        agentSandboxBackups.catalog_organization_id,
        agentSandboxBackups.catalog_agent_id,
        agentSandboxBackups.backup_operation_id,
        agentSandboxBackups.lifecycle_generation,
        agentSandboxBackups.lifecycle_revision,
        agentSandboxBackups.manifest_digest,
      ],
    }).onDelete("restrict"),
    shape_check: check(
      "agent_backup_restore_receipts_shape_check",
      sql`(${table.source_lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.activation_purpose} = 'restore'
        AND ${table.manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.seed_receipt_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.activation_receipt_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.receipt_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.restore_generation} > 0) IS TRUE`,
    ),
  }),
);

export type AgentActivationPublication = InferSelectModel<typeof agentActivationPublications>;
export type AgentVaultKeySeedReceipt = InferSelectModel<typeof agentVaultKeySeedReceipts>;
export type AgentBackupRestoreReceipt = InferSelectModel<typeof agentBackupRestoreReceipts>;
