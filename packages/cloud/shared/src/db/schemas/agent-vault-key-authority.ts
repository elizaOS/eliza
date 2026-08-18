/** Durable KMS-wrapped vault authority and immutable backup bindings. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentBackupCatalogAuthorities, agentSandboxBackups } from "./agent-sandboxes";
import { organizations } from "./organizations";

export const AGENT_VAULT_KEY_AUTHORITY_FORMAT = "kms-aead-vault-passphrase-v1" as const;
export const AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION =
  "elizaos.agent-vault-key.kms-context.v1" as const;
export const AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION =
  "elizaos.agent-vault-key.authority-receipt.v1" as const;

export const agentVaultKeyGenerations = pgTable(
  "agent_vault_key_generations",
  {
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    generation_id: uuid("generation_id").notNull(),
    source_activation_generation: uuid("source_activation_generation").notNull(),
    supersedes_generation_id: uuid("supersedes_generation_id"),
    format: text("format").notNull(),
    kms_key_id: text("kms_key_id").notNull(),
    kms_key_version: bigint("kms_key_version", { mode: "bigint" }).notNull(),
    kms_context: text("kms_context").notNull(),
    kms_context_derivation: text("kms_context_derivation").notNull(),
    wrapped_ciphertext_base64: text("wrapped_ciphertext_base64").notNull(),
    wrapped_nonce_base64: text("wrapped_nonce_base64").notNull(),
    wrapped_auth_tag_base64: text("wrapped_auth_tag_base64").notNull(),
    wrapped_envelope_sha256: text("wrapped_envelope_sha256").notNull(),
    authority_receipt_derivation: text("authority_receipt_derivation").notNull(),
    authority_receipt_digest: text("authority_receipt_digest").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organization_id, table.agent_id, table.generation_id] }),
    catalog_authority_fk: foreignKey({
      name: "agent_vault_key_generations_catalog_authority_fkey",
      columns: [table.organization_id, table.agent_id],
      foreignColumns: [
        agentBackupCatalogAuthorities.organization_id,
        agentBackupCatalogAuthorities.agent_id,
      ],
    }).onDelete("restrict"),
    supersedes_fk: foreignKey({
      name: "agent_vault_key_generations_supersedes_fkey",
      columns: [table.organization_id, table.agent_id, table.supersedes_generation_id],
      foreignColumns: [table.organization_id, table.agent_id, table.generation_id],
    }).onDelete("restrict"),
    receipt_authority_unique: unique("agent_vault_key_generations_receipt_authority_unique").on(
      table.organization_id,
      table.agent_id,
      table.generation_id,
      table.authority_receipt_digest,
    ),
    one_root_uidx: uniqueIndex("agent_vault_key_generations_one_root_uidx")
      .on(table.organization_id, table.agent_id)
      .where(sql`${table.supersedes_generation_id} IS NULL`),
    one_successor_uidx: uniqueIndex("agent_vault_key_generations_one_successor_uidx")
      .on(table.organization_id, table.agent_id, table.supersedes_generation_id)
      .where(sql`${table.supersedes_generation_id} IS NOT NULL`),
    envelope_shape_check: check(
      "agent_vault_key_generations_envelope_shape_check",
      sql`(${table.format} = 'kms-aead-vault-passphrase-v1'
        AND ${table.kms_key_id} = btrim(${table.kms_key_id})
        AND octet_length(${table.kms_key_id}) BETWEEN 1 AND 512
        AND ${table.kms_key_version} BETWEEN 1 AND 9007199254740991
        AND octet_length(${table.kms_context}) BETWEEN 1 AND 65536
        AND ${table.kms_context_derivation} = 'elizaos.agent-vault-key.kms-context.v1'
        AND ${table.wrapped_ciphertext_base64} ~ '^[A-Za-z0-9+/]{43}=$'
        AND ${table.wrapped_nonce_base64} ~ '^[A-Za-z0-9+/]{16}$'
        AND ${table.wrapped_auth_tag_base64} ~ '^[A-Za-z0-9+/]{22}==$'
        AND ${table.wrapped_envelope_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.authority_receipt_derivation} =
          'elizaos.agent-vault-key.authority-receipt.v1'
        AND ${table.authority_receipt_digest} ~ '^[0-9a-f]{64}$'
        AND ${table.supersedes_generation_id} IS DISTINCT FROM ${table.generation_id}) IS TRUE`,
    ),
  }),
);

export const agentVaultKeyAuthorities = pgTable(
  "agent_vault_key_authorities",
  {
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
    current_generation_id: uuid("current_generation_id").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(sql`1`),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organization_id, table.agent_id] }),
    catalog_authority_fk: foreignKey({
      name: "agent_vault_key_authorities_catalog_authority_fkey",
      columns: [table.organization_id, table.agent_id],
      foreignColumns: [
        agentBackupCatalogAuthorities.organization_id,
        agentBackupCatalogAuthorities.agent_id,
      ],
    }).onDelete("restrict"),
    generation_fk: foreignKey({
      name: "agent_vault_key_authorities_generation_fkey",
      columns: [table.organization_id, table.agent_id, table.current_generation_id],
      foreignColumns: [
        agentVaultKeyGenerations.organization_id,
        agentVaultKeyGenerations.agent_id,
        agentVaultKeyGenerations.generation_id,
      ],
    }).onDelete("restrict"),
    revision_check: check("agent_vault_key_authorities_revision_check", sql`${table.revision} > 0`),
  }),
);

export const agentVaultKeyBackupBindings = pgTable(
  "agent_vault_key_backup_bindings",
  {
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    agent_id: uuid("agent_id").notNull(),
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
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organization_id, table.backup_id] }),
    receipt_authority_unique: unique("agent_vault_key_backup_bindings_receipt_authority_unique").on(
      table.organization_id,
      table.agent_id,
      table.backup_id,
      table.operation_id,
      table.source_activation_generation,
      table.source_lifecycle_revision,
      table.manifest_sha256,
      table.vault_key_generation_id,
      table.vault_key_authority_receipt_digest,
    ),
    backup_authority_fk: foreignKey({
      name: "agent_vault_key_backup_bindings_backup_authority_fkey",
      columns: [
        table.backup_id,
        table.organization_id,
        table.agent_id,
        table.operation_id,
        table.source_activation_generation,
        table.source_lifecycle_revision,
        table.manifest_sha256,
        table.vault_key_generation_id,
        table.vault_key_authority_receipt_digest,
      ],
      foreignColumns: [
        agentSandboxBackups.id,
        agentSandboxBackups.catalog_organization_id,
        agentSandboxBackups.catalog_agent_id,
        agentSandboxBackups.backup_operation_id,
        agentSandboxBackups.lifecycle_generation,
        agentSandboxBackups.lifecycle_revision,
        agentSandboxBackups.manifest_digest,
        agentSandboxBackups.vault_key_generation_id,
        agentSandboxBackups.vault_key_authority_receipt_digest,
      ],
    }).onDelete("restrict"),
    generation_authority_fk: foreignKey({
      name: "agent_vault_key_backup_bindings_generation_authority_fkey",
      columns: [
        table.organization_id,
        table.agent_id,
        table.vault_key_generation_id,
        table.vault_key_authority_receipt_digest,
      ],
      foreignColumns: [
        agentVaultKeyGenerations.organization_id,
        agentVaultKeyGenerations.agent_id,
        agentVaultKeyGenerations.generation_id,
        agentVaultKeyGenerations.authority_receipt_digest,
      ],
    }).onDelete("restrict"),
    manifest_check: check(
      "agent_vault_key_backup_bindings_manifest_check",
      sql`(${table.source_lifecycle_revision} BETWEEN 0 AND 18446744073709551615
        AND ${table.manifest_sha256} ~ '^[0-9a-f]{64}$'
        AND ${table.vault_key_authority_receipt_digest} ~ '^[0-9a-f]{64}$') IS TRUE`,
    ),
  }),
);

export type AgentVaultKeyGeneration = InferSelectModel<typeof agentVaultKeyGenerations>;
export type NewAgentVaultKeyGeneration = InferInsertModel<typeof agentVaultKeyGenerations>;
export type AgentVaultKeyAuthority = InferSelectModel<typeof agentVaultKeyAuthorities>;
export type AgentVaultKeyBackupBinding = InferSelectModel<typeof agentVaultKeyBackupBindings>;
