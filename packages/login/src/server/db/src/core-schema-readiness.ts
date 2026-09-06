/** Validates the deployed core schema against its immutable repair ledger and reviewed catalog. */
import { createPostgresClient } from "./client";

import catalogManifestJson from "./core-schema-catalog.json" with {
  type: "json",
};

import {
  assertStewardCoreRepairSchema,
  type LoadedStewardCoreRepairSource,
  loadStewardCoreRepairSources,
  mapStewardCatalog,
  queryStewardCatalog,
  queryStewardNonInternalTriggerFunctions,
  quoteStewardCoreRepairIdentifier,
  STEWARD_CORE_REPAIR_LEDGER,
  STEWARD_CORE_REPAIR_SOURCE_HEAD,
  STEWARD_CORE_REPAIR_VERSION,
  type StewardCatalogRecord,
  type StewardCoreRepairAction,
  type StewardCoreRepairExecutor,
  type StewardCoreRepairSchema,
  sha256,
  stewardCatalogKey,
} from "./core-schema-sources";

type CatalogKey = {
  kind: string;
  objectName: string;
};

type CatalogEnvelope = {
  keyCount: number;
  keys?: CatalogKey[];
  beforeHash: string;
  afterHash: string;
  deltaHash: string;
};

type ExactCatalogEnvelope = {
  recordCount: number;
  records: StewardCatalogRecord[];
  hash: string;
};

type SchemaCatalogManifest = {
  serverVersionNum: string;
  existing0083: CatalogEnvelope;
  changes0082: CatalogEnvelope;
  changes0084To0110: CatalogEnvelope & {
    semanticFinalCounts: Record<string, number>;
  };
  changes: CatalogEnvelope;
  nonInternalTriggers: {
    before: ExactCatalogEnvelope;
    after: ExactCatalogEnvelope;
  };
  nonInternalTriggerFunctions: {
    before: ExactCatalogEnvelope;
    after: ExactCatalogEnvelope;
  };
};

type CoreRepairCatalogManifest = {
  manifestVersion: number;
  repairVersion: string;
  sourceHead: string;
  schemas: Record<StewardCoreRepairSchema, SchemaCatalogManifest>;
};

const catalogManifest = catalogManifestJson as CoreRepairCatalogManifest;

export interface StewardCoreRepairTransactionClient
  extends StewardCoreRepairExecutor {
  begin<T>(
    callback: (transaction: StewardCoreRepairExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface StewardCoreRepairReservedClient
  extends StewardCoreRepairExecutor {
  release(): void;
}

export interface StewardCoreRepairClient
  extends StewardCoreRepairTransactionClient {
  reserve(): Promise<StewardCoreRepairReservedClient>;
  end(options?: { timeout?: number }): Promise<void>;
}

export type StewardCoreRepairPreflight = {
  executionReadyWithoutPolicyEvidence: number;
  externalCustodyNoncesWithoutIdentityDigest: number;
  googleOperationsNeedingRiskUpgrade: number;
  evmNonceNamespaces: number;
  unresolvedEvmNonceNamespaces: number;
};

export type RunStewardCoreRepairOptions = {
  expectedSchema: StewardCoreRepairSchema;
  client?: StewardCoreRepairClient;
  useAdvisoryLock?: boolean;
};

export type StewardCoreRepairInspection = {
  status: "eligible" | "already_applied";
  schema: StewardCoreRepairSchema;
  bundleHash: string;
  verifiedExisting: string[];
  preflight: StewardCoreRepairPreflight | null;
};

type LedgerRow = {
  migration_order: string | number;
  tag: string;
  action: StewardCoreRepairAction;
  source_hash: string;
  rendered_hash: string;
  target_schema: string;
  repair_version: string;
  source_head: string;
  bundle_hash: string;
};

function getSchemaManifest(
  schema: StewardCoreRepairSchema,
): SchemaCatalogManifest {
  if (
    catalogManifest.manifestVersion !== 2 ||
    catalogManifest.repairVersion !== STEWARD_CORE_REPAIR_VERSION ||
    catalogManifest.sourceHead !== STEWARD_CORE_REPAIR_SOURCE_HEAD
  ) {
    throw new Error(
      "core-repair catalog manifest metadata does not match the reviewed bundle",
    );
  }
  const manifest = catalogManifest.schemas[schema];
  if (
    !manifest ||
    manifest.changes.keyCount === 0 ||
    manifest.changes.keys?.length !== manifest.changes.keyCount ||
    manifest.existing0083.keyCount === 0 ||
    manifest.existing0083.keys?.length !== manifest.existing0083.keyCount ||
    manifest.changes0082.keyCount === 0 ||
    manifest.changes0084To0110.keyCount === 0 ||
    !isExactCatalogEnvelope(manifest.nonInternalTriggers?.before, "trigger") ||
    !isExactCatalogEnvelope(manifest.nonInternalTriggers?.after, "trigger") ||
    !isExactCatalogEnvelope(
      manifest.nonInternalTriggerFunctions?.before,
      "function",
    ) ||
    !isExactCatalogEnvelope(
      manifest.nonInternalTriggerFunctions?.after,
      "function",
    )
  ) {
    throw new Error(
      `core-repair catalog manifest for ${schema} is missing or empty`,
    );
  }
  return manifest;
}

function isExactCatalogEnvelope(
  envelope: ExactCatalogEnvelope | undefined,
  kind: string,
): envelope is ExactCatalogEnvelope {
  if (
    !envelope ||
    envelope.recordCount === 0 ||
    !Array.isArray(envelope.records) ||
    envelope.records.length !== envelope.recordCount ||
    envelope.records.some((record) => record.kind !== kind)
  ) {
    return false;
  }
  return sha256(JSON.stringify(envelope.records)) === envelope.hash;
}

async function assertCatalogPostgresMajor(
  transaction: StewardCoreRepairExecutor,
  manifest: SchemaCatalogManifest,
): Promise<void> {
  const rows = await transaction.unsafe<{ server_version_num: string }>(
    "SHOW server_version_num",
  );
  const actual = Number(rows[0]?.server_version_num);
  const generated = Number(manifest.serverVersionNum);
  if (
    !Number.isSafeInteger(actual) ||
    !Number.isSafeInteger(generated) ||
    Math.trunc(actual / 10_000) !== Math.trunc(generated / 10_000)
  ) {
    throw new Error(
      `core-repair catalog manifest was generated for PostgreSQL ${Math.trunc(generated / 10_000)}; ` +
        `resolved server major is ${Math.trunc(actual / 10_000)}; regenerate and review before repair`,
    );
  }
}

function getBundleHash(
  schema: StewardCoreRepairSchema,
  sources: LoadedStewardCoreRepairSource[],
  manifest: SchemaCatalogManifest,
): string {
  return sha256(
    JSON.stringify({
      repairVersion: STEWARD_CORE_REPAIR_VERSION,
      sourceHead: STEWARD_CORE_REPAIR_SOURCE_HEAD,
      schema,
      sources: sources.map(
        ({ order, tag, action, sourceHash, renderedHash }) => ({
          order,
          tag,
          action,
          sourceHash,
          renderedHash,
        }),
      ),
      existing0083: manifest.existing0083,
      changes: manifest.changes,
      nonInternalTriggers: manifest.nonInternalTriggers,
      nonInternalTriggerFunctions: manifest.nonInternalTriggerFunctions,
    }),
  );
}

function catalogPhaseHash(
  catalog: Map<string, StewardCatalogRecord[]>,
  keys: CatalogKey[],
): string {
  const phase = keys.map((key) => ({
    ...key,
    definitions: (catalog.get(stewardCatalogKey(key)) ?? []).map(
      (record) => record.definition,
    ),
  }));
  return sha256(JSON.stringify(phase));
}

function assertCatalogPhase(
  records: StewardCatalogRecord[],
  envelope: CatalogEnvelope,
  phase: "before" | "after",
  label: string,
): void {
  const keys = envelope.keys;
  if (!keys || keys.length !== envelope.keyCount) {
    throw new Error(
      `${label} catalog envelope does not contain its reviewed keys`,
    );
  }
  const catalog = mapStewardCatalog(records);
  const actualHash = catalogPhaseHash(catalog, keys);
  const expectedHash =
    phase === "before" ? envelope.beforeHash : envelope.afterHash;
  if (actualHash !== expectedHash) {
    throw new Error(
      `${label} exact catalog envelope mismatch; refusing repair`,
    );
  }
}

function assertExactCatalogEnvelope(
  records: StewardCatalogRecord[],
  envelope: ExactCatalogEnvelope,
  kind: string,
  label: string,
): void {
  if (!isExactCatalogEnvelope(envelope, kind)) {
    throw new Error(`${label} reviewed catalog envelope is invalid`);
  }
  const actual = records.filter((record) => record.kind === kind);
  const serialized = JSON.stringify(actual);
  if (
    actual.length !== envelope.recordCount ||
    serialized !== JSON.stringify(envelope.records) ||
    sha256(serialized) !== envelope.hash
  ) {
    throw new Error(
      `${label} exact catalog envelope mismatch; refusing repair`,
    );
  }
}

async function assertNonInternalTriggerSurface(
  transaction: StewardCoreRepairExecutor,
  schema: StewardCoreRepairSchema,
  catalog: StewardCatalogRecord[],
  manifest: SchemaCatalogManifest,
  phase: "before" | "after",
  label: string,
): Promise<void> {
  assertExactCatalogEnvelope(
    catalog,
    manifest.nonInternalTriggers[phase],
    "trigger",
    `${label} noninternal-trigger`,
  );
  const triggerFunctions = await queryStewardNonInternalTriggerFunctions(
    transaction,
    schema,
  );
  assertExactCatalogEnvelope(
    triggerFunctions,
    manifest.nonInternalTriggerFunctions[phase],
    "function",
    `${label} bound-trigger-function`,
  );
}

async function resolveTargetSchema(
  transaction: StewardCoreRepairExecutor,
  expectedSchema: StewardCoreRepairSchema,
): Promise<StewardCoreRepairSchema> {
  const rows = await transaction.unsafe<{ schema_name: string | null }>(
    "SELECT pg_catalog.current_schema()::text AS schema_name",
  );
  const schema = rows[0]?.schema_name;
  if (!schema)
    throw new Error("DATABASE_URL search_path resolves to no target schema");
  assertStewardCoreRepairSchema(schema);
  if (schema !== expectedSchema) {
    throw new Error(
      `core-repair target schema mismatch: expected ${expectedSchema}, resolved ${schema}`,
    );
  }
  return schema;
}

type RepairSchemaTrustRow = {
  runtime_owns_schema: boolean;
  unexpected_create_grant: boolean;
  unexpected_relation_grant: boolean;
  unexpected_column_grant: boolean;
  unexpected_function_grant: boolean;
  unexpected_trigger_binding: boolean;
  enabled_event_trigger: boolean;
  unowned_relation_count: string | number;
  unowned_function_count: string | number;
  unowned_type_count: string | number;
};

/**
 * The repair executes reviewed migration SQL with owner authority. Require a
 * closed target namespace before setting any unqualified lookup path: the
 * effective role must be the exact schema/database owner, no third party may
 * CREATE objects there, and no existing target objects may remain owned by a
 * different role. This prevents pre-positioned function/relation shadowing.
 */
async function assertTrustedRepairSchema(
  transaction: StewardCoreRepairExecutor,
  schema: StewardCoreRepairSchema,
): Promise<void> {
  const rows = await transaction.unsafe<RepairSchemaTrustRow>(
    `
      SELECT
        (
          namespace.nspowner = runtime_role.oid
          OR (
            namespace.nspowner = database_owner_role.oid
            AND database.datdba = runtime_role.oid
          )
        ) AS runtime_owns_schema,
        EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            COALESCE(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
          ) AS schema_acl
          WHERE schema_acl.privilege_type = 'CREATE'
            AND schema_acl.grantee NOT IN (
              namespace.nspowner,
              runtime_role.oid
            )
        ) AS unexpected_create_grant,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS relation_acl
          WHERE relation_namespace.nspname = $1
            AND relation_acl.grantee NOT IN (relation.relowner, runtime_role.oid)
        ) AS unexpected_relation_grant,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute attribute
          JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
          JOIN pg_catalog.pg_namespace relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS column_acl
          WHERE relation_namespace.nspname = $1
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND column_acl.grantee NOT IN (relation.relowner, runtime_role.oid)
        ) AS unexpected_column_grant,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc procedure
          JOIN pg_catalog.pg_namespace procedure_namespace
            ON procedure_namespace.oid = procedure.pronamespace
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
          ) AS function_acl
          WHERE procedure_namespace.nspname = $1
            AND function_acl.grantee NOT IN (0, procedure.proowner, runtime_role.oid)
        ) AS unexpected_function_grant,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_trigger trigger_record
          JOIN pg_catalog.pg_class trigger_relation
            ON trigger_relation.oid = trigger_record.tgrelid
          JOIN pg_catalog.pg_namespace trigger_relation_namespace
            ON trigger_relation_namespace.oid = trigger_relation.relnamespace
          JOIN pg_catalog.pg_proc trigger_function
            ON trigger_function.oid = trigger_record.tgfoid
          JOIN pg_catalog.pg_namespace trigger_function_namespace
            ON trigger_function_namespace.oid = trigger_function.pronamespace
          WHERE trigger_relation_namespace.nspname = $1
            AND NOT trigger_record.tgisinternal
            AND (
              trigger_function_namespace.nspname <> $1
              OR trigger_function.proowner <> runtime_role.oid
            )
        ) AS unexpected_trigger_binding,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_event_trigger event_trigger
          WHERE event_trigger.evtenabled <> 'D'
        ) AS enabled_event_trigger,
        (
          SELECT count(*)
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace relation_namespace
            ON relation_namespace.oid = relation.relnamespace
          WHERE relation_namespace.nspname = $1
            AND relation.relowner <> runtime_role.oid
        ) AS unowned_relation_count,
        (
          SELECT count(*)
          FROM pg_catalog.pg_proc procedure
          JOIN pg_catalog.pg_namespace procedure_namespace
            ON procedure_namespace.oid = procedure.pronamespace
          WHERE procedure_namespace.nspname = $1
            AND procedure.proowner <> runtime_role.oid
        ) AS unowned_function_count,
        (
          SELECT count(*)
          FROM pg_catalog.pg_type type_record
          JOIN pg_catalog.pg_namespace type_namespace
            ON type_namespace.oid = type_record.typnamespace
          WHERE type_namespace.nspname = $1
            AND type_record.typowner <> runtime_role.oid
        ) AS unowned_type_count
      FROM pg_catalog.pg_namespace namespace
      JOIN pg_catalog.pg_database database
        ON database.datname = pg_catalog.current_database()
      JOIN pg_catalog.pg_roles runtime_role
        ON runtime_role.rolname = current_user
      JOIN pg_catalog.pg_roles database_owner_role
        ON database_owner_role.rolname = 'pg_database_owner'
      WHERE namespace.nspname = $1
    `,
    [schema],
  );
  const trust = rows[0];
  if (!trust || trust.runtime_owns_schema !== true) {
    throw new Error(
      "core-repair target schema is not owned by the effective operator role",
    );
  }
  if (trust.unexpected_create_grant === true) {
    throw new Error(
      "core-repair target schema grants CREATE to an unreviewed role",
    );
  }
  if (
    trust.unexpected_relation_grant === true ||
    trust.unexpected_column_grant === true ||
    trust.unexpected_function_grant === true
  ) {
    throw new Error(
      "core-repair target objects grant privileges to an unreviewed role",
    );
  }
  if (trust.unexpected_trigger_binding === true) {
    throw new Error("core-repair target contains an unreviewed trigger");
  }
  if (trust.enabled_event_trigger === true) {
    throw new Error("core-repair database contains an enabled event trigger");
  }
  if (
    Number(trust.unowned_relation_count) !== 0 ||
    Number(trust.unowned_function_count) !== 0 ||
    Number(trust.unowned_type_count) !== 0
  ) {
    throw new Error(
      "core-repair target schema contains objects owned by an unreviewed role",
    );
  }
}

function ledgerQualifiedName(schema: StewardCoreRepairSchema): string {
  return `${quoteStewardCoreRepairIdentifier(schema)}.${quoteStewardCoreRepairIdentifier(
    STEWARD_CORE_REPAIR_LEDGER,
  )}`;
}

async function ledgerExists(
  transaction: StewardCoreRepairExecutor,
  schema: StewardCoreRepairSchema,
): Promise<boolean> {
  const rows = await transaction.unsafe<{ relation_name: string | null }>(
    "SELECT pg_catalog.to_regclass($1)::text AS relation_name",
    [`${schema}.${STEWARD_CORE_REPAIR_LEDGER}`],
  );
  return Boolean(rows[0]?.relation_name);
}

async function assertLedger(
  transaction: StewardCoreRepairExecutor,
  schema: StewardCoreRepairSchema,
  sources: LoadedStewardCoreRepairSource[],
  bundleHash: string,
): Promise<void> {
  const ledger = ledgerQualifiedName(schema);
  const rows = await transaction.unsafe<LedgerRow>(`
    SELECT
      migration_order, tag, action, source_hash, rendered_hash,
      target_schema, repair_version, source_head, bundle_hash
    FROM ${ledger}
    ORDER BY migration_order
  `);
  if (rows.length !== sources.length) {
    throw new Error("Steward-owned core-repair ledger has the wrong row count");
  }
  for (let index = 0; index < sources.length; index += 1) {
    const row = rows[index];
    const source = sources[index];
    if (
      !row ||
      !source ||
      Number(row.migration_order) !== source.order ||
      row.tag !== source.tag ||
      row.action !== source.action ||
      row.source_hash !== source.sourceHash ||
      row.rendered_hash !== source.renderedHash ||
      row.target_schema !== schema ||
      row.repair_version !== STEWARD_CORE_REPAIR_VERSION ||
      row.source_head !== STEWARD_CORE_REPAIR_SOURCE_HEAD ||
      row.bundle_hash !== bundleHash
    ) {
      throw new Error(
        `Steward-owned core-repair ledger mismatch at order ${index + 1}`,
      );
    }
  }
}

async function inspectAppliedInTransaction(
  transaction: StewardCoreRepairExecutor,
  expectedSchema: StewardCoreRepairSchema,
): Promise<StewardCoreRepairInspection & { status: "already_applied" }> {
  await transaction.unsafe(
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  await transaction.unsafe("SET LOCAL statement_timeout = '2s'");
  await transaction.unsafe(
    "SET LOCAL idle_in_transaction_session_timeout = '2s'",
  );

  const schema = await resolveTargetSchema(transaction, expectedSchema);
  await assertTrustedRepairSchema(transaction, schema);
  const quotedSchema = quoteStewardCoreRepairIdentifier(schema);
  await transaction.unsafe(`SET LOCAL search_path TO ${quotedSchema}`);
  const manifest = getSchemaManifest(schema);
  await assertCatalogPostgresMajor(transaction, manifest);
  const sources = loadStewardCoreRepairSources(schema);
  const bundleHash = getBundleHash(schema, sources, manifest);
  if (!(await ledgerExists(transaction, schema))) {
    throw new Error("Steward core repair ledger is missing");
  }
  await assertLedger(transaction, schema, sources, bundleHash);
  const catalog = await queryStewardCatalog(transaction, schema);
  await assertNonInternalTriggerSurface(
    transaction,
    schema,
    catalog,
    manifest,
    "after",
    "release-readiness",
  );
  assertCatalogPhase(catalog, manifest.changes, "after", "release-readiness");
  return {
    status: "already_applied",
    schema,
    bundleHash,
    verifiedExisting: sources
      .filter((source) => source.action === "verified_existing")
      .map((source) => source.tag),
    preflight: null,
  };
}

/**
 * Runtime readiness variant of the operator inspector. It only accepts the
 * fully applied repair, validates both exact provenance and the live reviewed
 * catalog, and fails immediately when the ledger is absent. Unlike the
 * operator preflight it never scans production data to determine eligibility.
 */
export async function inspectAppliedStewardCoreRepair(
  options: Pick<RunStewardCoreRepairOptions, "expectedSchema" | "client">,
): Promise<StewardCoreRepairInspection & { status: "already_applied" }> {
  const ownsClient = !options.client;
  const client =
    options.client ??
    (createPostgresClient() as unknown as StewardCoreRepairClient);
  try {
    return await client.begin((transaction) =>
      inspectAppliedInTransaction(transaction, options.expectedSchema),
    );
  } finally {
    if (ownsClient) {
      await (
        client as unknown as {
          end(options?: { timeout?: number }): Promise<void>;
        }
      ).end({
        timeout: 5,
      });
    }
  }
}
