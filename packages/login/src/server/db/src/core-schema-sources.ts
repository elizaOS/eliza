/** Loads immutable migration fingerprints and reads PostgreSQL catalogs for production schema verification. */
import { createHash } from "node:crypto";

import { readFileSync } from "node:fs";

const MIGRATIONS_FOLDER = new URL("../drizzle", import.meta.url).pathname;

export const STEWARD_CORE_REPAIR_SOURCE_HEAD =
  "53399910ab9288297981e1b5679b293ec732e414";

export const STEWARD_CORE_REPAIR_VERSION = "prod-core-0082-0110-v1";

export const STEWARD_CORE_REPAIR_LEDGER = "__steward_core_repair_migrations";

export type StewardCoreRepairSchema = "public" | "steward";

export type StewardCoreRepairAction = "applied" | "verified_existing";

export type StewardCoreRepairSourceExpectation = {
  order: number;
  tag: string;
  action: StewardCoreRepairAction;
  sourceHash: string;
};

export type LoadedStewardCoreRepairSource =
  StewardCoreRepairSourceExpectation & {
    source: string;
    rendered: string;
    renderedHash: string;
  };

export type StewardCatalogRecord = {
  kind: string;
  objectName: string;
  definition: string;
};

export interface StewardCoreRepairExecutor {
  unsafe<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<T[]>;
}

export const STEWARD_CORE_REPAIR_SOURCES: readonly StewardCoreRepairSourceExpectation[] =
  [
    {
      order: 1,
      tag: "0082_execution_authorization_v2",
      action: "applied",
      sourceHash:
        "6a573ce1dd0abc212d8b2f7cf1153172a492489afe300cb5a8735f6b7fbc5d11",
    },
    {
      order: 2,
      tag: "0083_provider_approval_quorum",
      action: "verified_existing",
      sourceHash:
        "dce36592eca9f1d7485705103787b05834be3d1a073ca4a5aa1c5ab90d9f91d9",
    },
    {
      order: 3,
      tag: "0084_provider_action_reservation_reconciliation",
      action: "applied",
      sourceHash:
        "7c055c8beb14c580ba77cfefade89819cea6301550ea2c81e931e6602a8a1c4a",
    },
    {
      order: 4,
      tag: "0085_generic_http_profile",
      action: "applied",
      sourceHash:
        "3a53f7f742d548368da691ca9909c9dee6b44d9123119330b8572c26e81a72ad",
    },
    {
      order: 5,
      tag: "0086_audit_retention_archives",
      action: "applied",
      sourceHash:
        "3b8bdc318f2b12440d6696277f49bd76134d81f25fc9a4a15d6c721dce60bd06",
    },
    {
      order: 6,
      tag: "0087_external_custody_execution_binding",
      action: "applied",
      sourceHash:
        "6e1effa711ee7d6d24dd4a575388141c1835e7578f95b0b6ecdb6f546452e4a0",
    },
    {
      order: 7,
      tag: "0088_provider_agent_budgets",
      action: "applied",
      sourceHash:
        "be03dd21de532e78c9eaf91deb554477876de637915a9470c8501d683e5a58f5",
    },
    {
      order: 8,
      tag: "0089_rfc3161_checkpoint_proofs",
      action: "applied",
      sourceHash:
        "59a209d154108e44e88651538a78531de195f7f605adb5444cf4cff3d905c0b5",
    },
    {
      order: 9,
      tag: "0090_provider_action_approval_evidence_write_once",
      action: "applied",
      sourceHash:
        "00a58235b8beb0730b8a3393fca23e7dc82cc94b89b587bfe793f0b16bc61b57",
    },
    {
      order: 10,
      tag: "0091_external_custody_outcome_reconciliation",
      action: "applied",
      sourceHash:
        "2e1732248cfcbaa299bf7513aaed9145ff5a9f14308f0a910aca9179b912508f",
    },
    {
      order: 11,
      tag: "0092_provider_budget_tenant_reservation_handles",
      action: "applied",
      sourceHash:
        "eb4e84f8e91cf713ca3764ce8a82cdd01b84759ab7722b27b2280c9c4cb98722",
    },
    {
      order: 12,
      tag: "0093_upstream_credential_leases",
      action: "applied",
      sourceHash:
        "b3b6390ef05751d669df2c630a4e66fc8efe932a55b5b076ff3ba58b099c14cb",
    },
    {
      order: 13,
      tag: "0094_operator_transfer_reservations",
      action: "applied",
      sourceHash:
        "3884345a0e73c081015ecd9fef50ec36b1bf8eb025a3e51f2d13f14258ee8a58",
    },
    {
      order: 14,
      tag: "0095_approval_queue_agent_pagination",
      action: "applied",
      sourceHash:
        "c03273946028e604decaf0465730081b4af2452d8cc08fcf108a6bce5c48c368",
    },
    {
      order: 15,
      tag: "0096_slack_provider_profile",
      action: "applied",
      sourceHash:
        "890f45779fe40b18f8d556e6a8845c9021cc6a1006dccfeaac0d5d54dbf7af48",
    },
    {
      order: 16,
      tag: "0097_google_provider_profile",
      action: "applied",
      sourceHash:
        "e2363100ab4762c5f93dc160d67fe73e7f3e54e97e98ccec3e723f1fedcfc541",
    },
    {
      order: 17,
      tag: "0098_google_credential_lifecycles",
      action: "applied",
      sourceHash:
        "cec02c2e6266b86e0b41493ecc279c04fc00c9280a2dc9415d6efcb07b477174",
    },
    {
      order: 18,
      tag: "0099_google_disconnect_lifecycle_kind",
      action: "applied",
      sourceHash:
        "d9232b5ea9eaa42dcc85c23047260f0ff04cd9519a945d7677eba8eb6ab02636",
    },
    {
      order: 19,
      tag: "0100_sigv4_injection",
      action: "applied",
      sourceHash:
        "4d26b0006a579c5839f20d578ca721a99a34c4cbed5b64134b56ab01a7010cb7",
    },
    {
      order: 20,
      tag: "0101_operator_transfer_integrity",
      action: "applied",
      sourceHash:
        "6da9ec8b64a8f79c44c605216cfe506b08b4f6b274a9d44466b38e17ce5f84b9",
    },
    {
      order: 21,
      tag: "0102_google_consequential_write_risk",
      action: "applied",
      sourceHash:
        "b777c64ec197dd14f3232531f218cba766d8bfff4da78cb726537c1ae4a49143",
    },
    {
      order: 22,
      tag: "0103_google_refresh_reconnect_recovery",
      action: "applied",
      sourceHash:
        "33152057a9797046d010bc16fe161577f8d21ed1c0944d4abad6013bbf537696",
    },
    {
      order: 23,
      tag: "0104_x_refresh_rotation_recovery",
      action: "applied",
      sourceHash:
        "5e9b96e022e425c4d1870f1af2b191412aaef3746ea31c83c2d2cae4ac3324aa",
    },
    {
      order: 24,
      tag: "0105_x_connect_exchange_recovery",
      action: "applied",
      sourceHash:
        "b5f14e56faad3bd254744b9cdc15c40337fabdf31647dd427b40a8b72d4c5c3c",
    },
    {
      order: 25,
      tag: "0106_x_disconnect_recovery_bounds",
      action: "applied",
      sourceHash:
        "1816dada22ae4b4017523172a102913fdfa99656d9fc6dfffb1cf574ab7480ea",
    },
    {
      order: 26,
      tag: "0107_x_disconnect_route_recovery",
      action: "applied",
      sourceHash:
        "c09138d58140605e817d0abf4d8f91eece7742ff0f6660afd3302d92fe9a5879",
    },
    {
      order: 27,
      tag: "0108_evm_nonce_tenant_ownership",
      action: "applied",
      sourceHash:
        "957fcd894663708ee2ac20e9377bd3a3573643c10740aae6844b922697fccd2a",
    },
    {
      order: 28,
      tag: "0109_agent_policy_builder_perps_reconcile",
      action: "applied",
      sourceHash:
        "f523a475088a6576d4676434dc84ae3a5b074e93144186c6c66152b7ee6b7b9f",
    },
    {
      order: 29,
      tag: "0110_agent_delete_lease_lifecycle",
      action: "applied",
      sourceHash:
        "8edf162111c93ddb16a4d6c7f7b36831ad482edff33a44d4d8d00348ab822d8f",
    },
  ] as const;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function quoteStewardCoreRepairIdentifier(identifier: string): string {
  if (!identifier || identifier.includes("\0")) {
    throw new Error("database identifier is invalid");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function assertStewardCoreRepairSchema(
  schema: string,
): asserts schema is StewardCoreRepairSchema {
  if (schema !== "public" && schema !== "steward") {
    throw new Error(
      `unsupported core-repair schema ${schema}; only the reviewed public and steward manifests are eligible`,
    );
  }
}

function replaceReviewedMigrationFragment(
  source: string,
  expected: string,
  replacement: string,
  label: string,
): string {
  if (
    !source.includes(expected) ||
    source.indexOf(expected) !== source.lastIndexOf(expected)
  ) {
    throw new Error(
      `${label} no longer contains its one reviewed migration fragment`,
    );
  }
  return source.replace(expected, replacement);
}

export function renderStewardCoreRepairMigration(
  tag: string,
  source: string,
  schema: StewardCoreRepairSchema,
): string {
  let rendered = source;
  if (tag === "0108_evm_nonce_tenant_ownership") {
    rendered = replaceReviewedMigrationFragment(
      rendered,
      'UPDATE "evm_wallet_nonces" SET "wallet_address" = lower("wallet_address");',
      `ALTER TABLE "evm_wallet_nonces"
  REPLICA IDENTITY FULL;
--> statement-breakpoint
UPDATE "evm_wallet_nonces" SET "wallet_address" = lower("wallet_address");`,
      "0108 evm_wallet_nonces update",
    );
    rendered = replaceReviewedMigrationFragment(
      rendered,
      'UPDATE "evm_wallet_nonce_inflight" SET "wallet_address" = lower("wallet_address");',
      `ALTER TABLE "evm_wallet_nonce_inflight"
  REPLICA IDENTITY FULL;
--> statement-breakpoint
UPDATE "evm_wallet_nonce_inflight" SET "wallet_address" = lower("wallet_address");`,
      "0108 evm_wallet_nonce_inflight update",
    );
    rendered = replaceReviewedMigrationFragment(
      rendered,
      `CREATE UNIQUE INDEX "evm_wallet_nonces_wallet_chain_idx"
  ON "evm_wallet_nonces" ("tenant_id", "wallet_address", "chain_id");`,
      `CREATE UNIQUE INDEX "evm_wallet_nonces_wallet_chain_idx"
  ON "evm_wallet_nonces" ("tenant_id", "wallet_address", "chain_id");
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonces"
  REPLICA IDENTITY USING INDEX "evm_wallet_nonces_wallet_chain_idx";`,
      "0108 evm_wallet_nonces final replica identity",
    );
    rendered = replaceReviewedMigrationFragment(
      rendered,
      `CREATE UNIQUE INDEX "evm_wallet_nonce_inflight_key_idx"
  ON "evm_wallet_nonce_inflight" ("tenant_id", "wallet_address", "chain_id", "nonce");`,
      `CREATE UNIQUE INDEX "evm_wallet_nonce_inflight_key_idx"
  ON "evm_wallet_nonce_inflight" ("tenant_id", "wallet_address", "chain_id", "nonce");
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonce_inflight"
  REPLICA IDENTITY USING INDEX "evm_wallet_nonce_inflight_key_idx";`,
      "0108 evm_wallet_nonce_inflight final replica identity",
    );
  }

  if (schema === "public") return rendered;

  const quotedSchema = quoteStewardCoreRepairIdentifier(schema);
  if (tag === "0091_external_custody_outcome_reconciliation") {
    const expected = 'ALTER TYPE "public"."transaction_status"';
    if (
      !source.includes(expected) ||
      source.indexOf(expected) !== source.lastIndexOf(expected)
    ) {
      throw new Error(
        "0091 no longer contains its one reviewed public-schema binding",
      );
    }
    const rendered = source.replace(
      expected,
      `ALTER TYPE ${quotedSchema}."transaction_status"`,
    );
    if (rendered.includes('"public"."transaction_status"')) {
      throw new Error("0091 retained an unrendered public-schema binding");
    }
    return rendered;
  }

  if (tag === "0110_agent_delete_lease_lifecycle") {
    if (!source.includes("public.") || !source.includes("pg_catalog, public")) {
      throw new Error("0110 reviewed public-schema bindings are missing");
    }
    const rendered = source
      .replaceAll("public.", `${quotedSchema}.`)
      .replaceAll("pg_catalog, public", `pg_catalog, ${quotedSchema}`);
    if (
      rendered.includes("public.") ||
      rendered.includes("pg_catalog, public")
    ) {
      throw new Error("0110 retained an unrendered public-schema binding");
    }
    return rendered;
  }

  return rendered;
}

export function loadStewardCoreRepairSources(
  schema: StewardCoreRepairSchema,
): LoadedStewardCoreRepairSource[] {
  return STEWARD_CORE_REPAIR_SOURCES.map((expectation) => {
    const source = readFileSync(
      `${MIGRATIONS_FOLDER}/${expectation.tag}.sql`,
      "utf8",
    );
    const sourceHash = sha256(source);
    if (sourceHash !== expectation.sourceHash) {
      throw new Error(
        `${expectation.tag} source hash mismatch: expected ${expectation.sourceHash}, got ${sourceHash}`,
      );
    }
    const rendered = renderStewardCoreRepairMigration(
      expectation.tag,
      source,
      schema,
    );
    return {
      ...expectation,
      source,
      rendered,
      renderedHash: sha256(rendered),
    };
  });
}

export async function queryStewardCatalog(
  executor: StewardCoreRepairExecutor,
  schema: StewardCoreRepairSchema,
): Promise<StewardCatalogRecord[]> {
  const rows = await executor.unsafe<{
    kind: string;
    object_name: string;
    definition: string;
  }>(
    `
      WITH catalog AS (
        SELECT
          'relation'::text AS kind,
          relation.relname AS object_name,
          relation.relkind::text || '|' || relation.relpersistence::text || '|' ||
            relation.relrowsecurity::text || '|' || relation.relforcerowsecurity::text || '|' ||
            relation.relreplident::text AS definition
        FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1::text
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')

        UNION ALL

        SELECT
          'column',
          relation.relname || '.' || attribute.attname,
          pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
            attribute.attnotnull::text || '|' || attribute.attidentity::text || '|' ||
            attribute.attgenerated::text || '|' ||
            COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, true), '')
        FROM pg_catalog.pg_attribute attribute
        JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        LEFT JOIN pg_catalog.pg_attrdef default_value
          ON default_value.adrelid = attribute.attrelid
         AND default_value.adnum = attribute.attnum
        WHERE namespace.nspname = $1::text
          AND relation.relkind IN ('r', 'p', 'v', 'm')
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped

        UNION ALL

        SELECT
          'constraint',
          relation.relname || '.' || constraint_record.conname,
          constraint_record.contype::text || '|' || constraint_record.convalidated::text || '|' ||
            constraint_record.condeferrable::text || '|' || constraint_record.condeferred::text || '|' ||
            pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
        FROM pg_catalog.pg_constraint constraint_record
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_record.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1::text

        UNION ALL

        SELECT
          'index',
          target.relname || '.' || index_relation.relname,
          index_record.indisunique::text || '|' || index_record.indisprimary::text || '|' ||
            index_record.indisvalid::text || '|' || index_record.indisready::text || '|' ||
            index_record.indisreplident::text || '|' ||
            pg_catalog.pg_get_indexdef(index_relation.oid, 0, true)
        FROM pg_catalog.pg_index index_record
        JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_record.indexrelid
        JOIN pg_catalog.pg_class target ON target.oid = index_record.indrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = target.relnamespace
        WHERE namespace.nspname = $1::text

        UNION ALL

        SELECT
          'trigger',
          relation.relname || '.' || trigger_record.tgname,
          trigger_record.tgenabled::text || '|' ||
            regexp_replace(pg_catalog.pg_get_triggerdef(trigger_record.oid, true), E'[\\n\\r\\t]+', ' ', 'g')
        FROM pg_catalog.pg_trigger trigger_record
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_record.tgrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1::text
          AND NOT trigger_record.tgisinternal

        UNION ALL

        SELECT
          'function',
          procedure.proname || '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')',
          procedure.prokind::text || '|' || pg_catalog.pg_get_function_result(procedure.oid) || '|' ||
            language.lanname || '|' || procedure.provolatile::text || '|' ||
            procedure.prosecdef::text || '|' || procedure.proparallel::text || '|' ||
            COALESCE(array_to_string(procedure.proconfig, ','), '') || '|' ||
            regexp_replace(pg_catalog.pg_get_functiondef(procedure.oid), E'[\\n\\r\\t]+', ' ', 'g')
        FROM pg_catalog.pg_proc procedure
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
        WHERE namespace.nspname = $1::text

        UNION ALL

        SELECT
          'enum',
          type_record.typname || '.' || enum_record.enumlabel,
          enum_record.enumsortorder::text
        FROM pg_catalog.pg_type type_record
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_record.typnamespace
        JOIN pg_catalog.pg_enum enum_record ON enum_record.enumtypid = type_record.oid
        WHERE namespace.nspname = $1::text

        UNION ALL

        SELECT
          'policy',
          relation.relname || '.' || policy_record.polname,
          policy_record.polcmd::text || '|' || policy_record.polpermissive::text || '|' ||
            COALESCE(pg_catalog.pg_get_expr(policy_record.polqual, policy_record.polrelid, true), '') || '|' ||
            COALESCE(pg_catalog.pg_get_expr(policy_record.polwithcheck, policy_record.polrelid, true), '')
        FROM pg_catalog.pg_policy policy_record
        JOIN pg_catalog.pg_class relation ON relation.oid = policy_record.polrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1::text
      )
      SELECT kind, object_name, definition
      FROM catalog
      ORDER BY kind, object_name, definition
    `,
    [schema],
  );

  return rows.map((row) => ({
    kind: row.kind,
    objectName: row.object_name,
    definition: row.definition,
  }));
}

export async function queryStewardNonInternalTriggerFunctions(
  executor: StewardCoreRepairExecutor,
  schema: StewardCoreRepairSchema,
): Promise<StewardCatalogRecord[]> {
  const rows = await executor.unsafe<{
    kind: string;
    object_name: string;
    definition: string;
  }>(
    `
      SELECT
        'function'::text AS kind,
        function_namespace.nspname || '.' || procedure.proname ||
          '(' || pg_catalog.pg_get_function_identity_arguments(procedure.oid) || ')' AS object_name,
        procedure.prokind::text || '|' || pg_catalog.pg_get_function_result(procedure.oid) || '|' ||
          language.lanname || '|' || procedure.provolatile::text || '|' ||
          procedure.prosecdef::text || '|' || procedure.proparallel::text || '|' ||
          COALESCE(array_to_string(procedure.proconfig, ','), '') || '|' ||
          regexp_replace(pg_catalog.pg_get_functiondef(procedure.oid), E'[\\n\\r\\t]+', ' ', 'g')
          AS definition
      FROM pg_catalog.pg_proc procedure
      JOIN pg_catalog.pg_namespace function_namespace
        ON function_namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_language language ON language.oid = procedure.prolang
      WHERE procedure.oid IN (
        SELECT DISTINCT trigger_record.tgfoid
        FROM pg_catalog.pg_trigger trigger_record
        JOIN pg_catalog.pg_class relation ON relation.oid = trigger_record.tgrelid
        JOIN pg_catalog.pg_namespace relation_namespace
          ON relation_namespace.oid = relation.relnamespace
        WHERE relation_namespace.nspname = $1::text
          AND NOT trigger_record.tgisinternal
      )
      ORDER BY kind, object_name, definition
    `,
    [schema],
  );

  return rows.map((row) => ({
    kind: row.kind,
    objectName: row.object_name,
    definition: row.definition,
  }));
}

export function stewardCatalogKey(
  record: Pick<StewardCatalogRecord, "kind" | "objectName">,
): string {
  return `${record.kind}\0${record.objectName}`;
}

export function mapStewardCatalog(
  records: StewardCatalogRecord[],
): Map<string, StewardCatalogRecord[]> {
  const catalog = new Map<string, StewardCatalogRecord[]>();
  for (const record of records) {
    const key = stewardCatalogKey(record);
    const existing = catalog.get(key) ?? [];
    existing.push(record);
    catalog.set(key, existing);
  }
  for (const group of catalog.values()) {
    group.sort((left, right) => {
      if (left.definition < right.definition) return -1;
      if (left.definition > right.definition) return 1;
      return 0;
    });
  }
  return catalog;
}
