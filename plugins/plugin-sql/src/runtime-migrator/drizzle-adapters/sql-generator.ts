/**
 * Turns a `SchemaDiff` (from diff-calculator) into an ordered list of raw SQL
 * migration statements — schemas and tables first, foreign keys after all
 * tables exist, then column/index/constraint alterations, mirroring
 * drizzle-kit's own statement ordering. Also runs a pre-flight data-loss
 * check (`checkForDataLoss`) that flags destructive type changes, dropped
 * tables/columns, and new NOT NULL columns without defaults. `ADD COLUMN` /
 * `DROP COLUMN` statements are emitted with `IF NOT EXISTS` / `IF EXISTS` so
 * a migration replays safely after a partial/crashed prior run.
 */
import { logger } from "@elizaos/core";
import type {
  SchemaCheckConstraint,
  SchemaColumn,
  SchemaForeignKey,
  SchemaIndex,
  SchemaPrimaryKey,
  SchemaSnapshot,
  SchemaTable,
  SchemaUniqueConstraint,
} from "../types";
import type { SchemaDiff } from "./diff-calculator";

/**
 * Data loss detection result
 * Based on Drizzle's pgPushUtils approach
 */
export interface DataLossCheck {
  hasDataLoss: boolean;
  tablesToRemove: string[];
  columnsToRemove: string[];
  tablesToTruncate: string[];
  typeChanges: Array<{
    table: string;
    column: string;
    from: string;
    to: string;
  }>;
  warnings: string[];
  requiresConfirmation: boolean;
}

/**
 * Check for potential data loss in schema changes
 * Based on Drizzle's pgSuggestions function
 */
export function checkForDataLoss(diff: SchemaDiff): DataLossCheck {
  const result: DataLossCheck = {
    hasDataLoss: false,
    tablesToRemove: [],
    columnsToRemove: [],
    tablesToTruncate: [],
    typeChanges: [],
    warnings: [],
    requiresConfirmation: false,
  };

  if (diff.tables.deleted.length > 0) {
    result.hasDataLoss = true;
    result.requiresConfirmation = true;
    result.tablesToRemove = [...diff.tables.deleted];
    for (const table of diff.tables.deleted) {
      result.warnings.push(`Table "${table}" will be dropped with all its data`);
    }
  }

  if (diff.columns.deleted.length > 0) {
    result.hasDataLoss = true;
    result.requiresConfirmation = true;
    for (const col of diff.columns.deleted) {
      result.columnsToRemove.push(`${col.table}.${col.column}`);
      result.warnings.push(`Column "${col.column}" in table "${col.table}" will be dropped`);
    }
  }

  for (const modified of diff.columns.modified) {
    const from = modified.changes.from;
    const to = modified.changes.to;

    if (!from || !to) continue;

    if (from.type !== to.type) {
      const isDestructive = checkIfTypeChangeIsDestructive(from.type, to.type);

      if (isDestructive) {
        result.hasDataLoss = true;
        result.requiresConfirmation = true;
        result.typeChanges.push({
          table: modified.table,
          column: modified.column,
          from: from.type,
          to: to.type,
        });
        result.tablesToTruncate.push(modified.table);
        result.warnings.push(
          `Column "${modified.column}" in table "${modified.table}" changes type from "${from.type}" to "${to.type}". ` +
            `This may require truncating the table to avoid data conversion errors.`
        );
      }
    }

    if (!from.notNull && to.notNull && !to.default) {
      result.hasDataLoss = true;
      result.requiresConfirmation = true;
      result.warnings.push(
        `Column "${modified.column}" in table "${modified.table}" is becoming NOT NULL without a default value. ` +
          `This will fail if the table contains NULL values.`
      );
    }
  }

  for (const added of diff.columns.added) {
    if (added.definition.notNull && !added.definition.default) {
      // Only a problem if the table already has rows, so this is a warning,
      // not a hard data-loss finding — requiresConfirmation stays untouched.
      result.warnings.push(
        `Column "${added.column}" is being added to table "${added.table}" as NOT NULL without a default value. ` +
          `This will fail if the table contains data.`
      );
    }
  }

  return result;
}

/**
 * Normalize SQL types for comparison
 * Handles equivalent type variations between introspected DB and schema definitions
 */
function normalizeType(type: string | undefined): string {
  if (!type) return "";

  const normalized = type.toLowerCase().trim();

  // Handle timestamp variations - all are equivalent
  if (
    normalized === "timestamp without time zone" ||
    normalized === "timestamp with time zone" ||
    normalized === "timestamptz"
  ) {
    return "timestamp";
  }

  // Handle serial vs integer with identity
  // serial is essentially integer with auto-increment
  if (normalized === "serial") {
    return "integer";
  }
  if (normalized === "bigserial") {
    return "bigint";
  }
  if (normalized === "smallserial") {
    return "smallint";
  }

  // Handle numeric/decimal equivalence
  if (normalized.startsWith("numeric") || normalized.startsWith("decimal")) {
    // Extract precision and scale if present
    const match = normalized.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (match) {
      return `numeric(${match[1]}${match[2] ? `,${match[2]}` : ""})`;
    }
    return "numeric";
  }

  // Handle varchar/character varying
  if (normalized.startsWith("character varying")) {
    return normalized.replace("character varying", "varchar");
  }

  // Handle text array variations
  if (normalized === "text[]" || normalized === "_text") {
    return "text[]";
  }

  return normalized;
}

/**
 * Check if a type change is destructive
 * Based on PostgreSQL's type casting rules
 */
function checkIfTypeChangeIsDestructive(fromType: string, toType: string): boolean {
  // First normalize the types to handle equivalent variations
  const normalizedFrom = normalizeType(fromType);
  const normalizedTo = normalizeType(toType);

  // If normalized types match, it's not destructive
  if (normalizedFrom === normalizedTo) {
    return false;
  }

  // Safe conversions (PostgreSQL) - based on Drizzle's logic
  const safeConversions: Record<string, string[]> = {
    smallint: ["integer", "bigint", "numeric", "real", "double precision"],
    integer: ["bigint", "numeric", "real", "double precision"],
    bigint: ["numeric"],
    real: ["double precision"],
    varchar: ["text"],
    char: ["varchar", "text"],
    citext: ["text"],
    text: ["citext"],
    // UUID to text is safe
    uuid: ["text", "varchar"],
    // Timestamp variations are generally safe (now handled by normalization)
    timestamp: ["timestamp"], // Simplified since normalization handles variations
    // Date/time conversions
    date: ["timestamp"],
    time: ["timetz"],
  };

  const fromBase = normalizedFrom.split("(")[0];
  const toBase = normalizedTo.split("(")[0];

  // Same type is always safe
  if (fromBase === toBase) {
    return false;
  }

  // Check if it's a safe conversion
  const safeTo = safeConversions[fromBase];
  if (safeTo?.includes(toBase)) {
    return false;
  }

  // All other conversions are considered potentially destructive
  return true;
}

/**
 * Generate SQL statements from a schema diff
 * This follows Drizzle's approach: create all tables first, then add foreign keys
 */
export async function generateMigrationSQL(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot,
  diff?: SchemaDiff
): Promise<string[]> {
  const statements: string[] = [];

  if (!diff) {
    const { calculateDiff } = await import("./diff-calculator");
    diff = await calculateDiff(previousSnapshot, currentSnapshot);
  }

  const dataLossCheck = checkForDataLoss(diff);

  if (dataLossCheck.warnings.length > 0) {
    logger.warn(
      { src: "plugin:sql", warnings: dataLossCheck.warnings },
      "Schema changes may cause data loss"
    );
  }

  // Phase 1: create every non-public schema referenced by a new table first.
  const schemasToCreate = new Set<string>();
  for (const tableName of diff.tables.created) {
    const table = currentSnapshot.tables[tableName];
    if (table) {
      const schema = table.schema || "public";
      if (schema !== "public") {
        schemasToCreate.add(schema);
      }
    }
  }

  for (const schema of schemasToCreate) {
    statements.push(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);
  }

  // Phase 2: CREATE TABLE for new tables, without foreign keys.
  const createTableStatements: string[] = [];
  const foreignKeyStatements: string[] = [];

  for (const tableName of diff.tables.created) {
    const table = currentSnapshot.tables[tableName];
    if (table) {
      const { tableSQL, fkSQLs } = generateCreateTableSQL(tableName, table);
      createTableStatements.push(tableSQL);
      foreignKeyStatements.push(...fkSQLs);
    }
  }

  statements.push(...createTableStatements);

  // Phase 3: add foreign keys after all tables exist, deduplicated by
  // constraint name to avoid re-adding the same constraint twice.
  const uniqueFKs = new Set<string>();
  const dedupedFKStatements: string[] = [];

  for (const fkSQL of foreignKeyStatements) {
    const match = fkSQL.match(/ADD CONSTRAINT "([^"]+)"/);
    if (match) {
      const constraintName = match[1];
      if (!uniqueFKs.has(constraintName)) {
        uniqueFKs.add(constraintName);
        dedupedFKStatements.push(fkSQL);
      }
    } else {
      dedupedFKStatements.push(fkSQL);
    }
  }

  statements.push(...dedupedFKStatements);

  // Phase 4: table modifications — drops, then column/index/constraint/FK changes.
  for (const tableName of diff.tables.deleted) {
    const [schema, name] = tableName.includes(".") ? tableName.split(".") : ["public", tableName];
    statements.push(`DROP TABLE IF EXISTS "${schema}"."${name}" CASCADE;`);
  }

  for (const added of diff.columns.added) {
    statements.push(generateAddColumnSQL(added.table, added.column, added.definition));
  }

  for (const deleted of diff.columns.deleted) {
    statements.push(generateDropColumnSQL(deleted.table, deleted.column));
  }

  for (const modified of diff.columns.modified) {
    const alterStatements = generateAlterColumnSQL(
      modified.table,
      modified.column,
      modified.changes
    );
    statements.push(...alterStatements);
  }

  // Altered indexes are dropped (old definition) then recreated (new definition).
  for (const index of diff.indexes.deleted) {
    statements.push(generateDropIndexSQL(index));
  }

  for (const alteredIndex of diff.indexes.altered) {
    statements.push(generateDropIndexSQL(alteredIndex.old));
  }

  for (const index of diff.indexes.created) {
    statements.push(generateCreateIndexSQL(index));
  }

  for (const alteredIndex of diff.indexes.altered) {
    statements.push(generateCreateIndexSQL(alteredIndex.new));
  }

  for (const constraint of diff.uniqueConstraints.created) {
    // Skip constraints on tables just created above — CREATE TABLE already includes them.
    const isNewTable = diff.tables.created.some((tableName) => {
      const [schema, table] = tableName.includes(".")
        ? tableName.split(".")
        : ["public", tableName];
      const constraintTable =
        (constraint as SchemaUniqueConstraint & { table?: string }).table || "";
      const [constraintSchema, constraintTableName] = constraintTable.includes(".")
        ? constraintTable.split(".")
        : ["public", constraintTable];
      return table === constraintTableName && schema === constraintSchema;
    });

    if (!isNewTable) {
      statements.push(generateCreateUniqueConstraintSQL(constraint));
    }
  }

  for (const constraint of diff.uniqueConstraints.deleted) {
    statements.push(generateDropUniqueConstraintSQL(constraint));
  }

  for (const constraint of diff.checkConstraints.created) {
    // Skip constraints on tables just created above — CREATE TABLE already includes them.
    const isNewTable = diff.tables.created.some((tableName) => {
      const [schema, table] = tableName.includes(".")
        ? tableName.split(".")
        : ["public", tableName];
      const constraintTable =
        (constraint as SchemaCheckConstraint & { table?: string }).table || "";
      const [constraintSchema, constraintTableName] = constraintTable.includes(".")
        ? constraintTable.split(".")
        : ["public", constraintTable];
      return table === constraintTableName && schema === constraintSchema;
    });

    if (!isNewTable) {
      statements.push(generateCreateCheckConstraintSQL(constraint));
    }
  }

  for (const constraint of diff.checkConstraints.deleted) {
    statements.push(generateDropCheckConstraintSQL(constraint));
  }

  for (const fk of diff.foreignKeys.deleted) {
    statements.push(generateDropForeignKeySQL(fk));
  }

  for (const alteredFK of diff.foreignKeys.altered) {
    statements.push(generateDropForeignKeySQL(alteredFK.old));
  }

  for (const fk of diff.foreignKeys.created) {
    // Skip FKs on tables just created above (Phase 3 already added them).
    const tableFrom = fk.tableFrom || "";
    const schemaFrom = fk.schemaFrom || "public";

    const isNewTable = diff.tables.created.some((tableName) => {
      const [createdSchema, createdTable] = tableName.includes(".")
        ? tableName.split(".")
        : ["public", tableName];

      return createdTable === tableFrom && createdSchema === schemaFrom;
    });

    if (!isNewTable) {
      statements.push(generateCreateForeignKeySQL(fk));
    }
  }

  for (const alteredFK of diff.foreignKeys.altered) {
    statements.push(generateCreateForeignKeySQL(alteredFK.new));
  }

  return statements;
}

/**
 * Generate CREATE TABLE SQL (following Drizzle's pattern)
 * Returns the table creation SQL and separate foreign key SQLs
 */
function generateCreateTableSQL(
  fullTableName: string,
  table: SchemaTable
): { tableSQL: string; fkSQLs: string[] } {
  const [schema, tableName] = fullTableName.includes(".")
    ? fullTableName.split(".")
    : ["public", fullTableName];
  const columns: string[] = [];
  const fkSQLs: string[] = [];

  // Add columns
  for (const [colName, colDef] of Object.entries(table.columns || {})) {
    columns.push(generateColumnDefinition(colName, colDef));
  }

  // Add composite primary keys if exists
  const primaryKeys = table.compositePrimaryKeys || {};
  for (const [pkName, pkDef] of Object.entries(primaryKeys)) {
    const pk = pkDef as SchemaPrimaryKey;
    if (pk.columns && pk.columns.length > 0) {
      columns.push(
        `CONSTRAINT "${pkName}" PRIMARY KEY (${pk.columns.map((c) => `"${c}"`).join(", ")})`
      );
    }
  }

  // Add unique constraints
  const uniqueConstraints = table.uniqueConstraints || {};
  for (const [uqName, uqDef] of Object.entries(uniqueConstraints)) {
    const uq = uqDef as SchemaUniqueConstraint;
    if (uq.columns && uq.columns.length > 0) {
      const uniqueDef = uq.nullsNotDistinct
        ? `CONSTRAINT "${uqName}" UNIQUE NULLS NOT DISTINCT (${uq.columns.map((c) => `"${c}"`).join(", ")})`
        : `CONSTRAINT "${uqName}" UNIQUE (${uq.columns.map((c) => `"${c}"`).join(", ")})`;
      columns.push(uniqueDef);
    }
  }

  // Add check constraints
  const checkConstraints = table.checkConstraints || {};
  for (const [checkName, checkDef] of Object.entries(checkConstraints)) {
    const check = checkDef as SchemaCheckConstraint;
    if (check.value) {
      columns.push(`CONSTRAINT "${checkName}" CHECK (${check.value})`);
    }
  }

  // Following drizzle-kit pattern: don't create schema here, it's handled separately
  const tableSQL = `CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (\n  ${columns.join(",\n  ")}\n);`;

  // Collect foreign keys to be added AFTER all tables are created
  const foreignKeys = table.foreignKeys || {};
  for (const [fkName, fkDef] of Object.entries(foreignKeys)) {
    const fk = fkDef as SchemaForeignKey;
    const fkSQL = wrapConstraintCreationGuard(
      fkName,
      buildCreateForeignKeyBodySQL({
        ...fk,
        name: fkName,
        schemaFrom: schema,
        tableFrom: tableName,
      })
    );
    fkSQLs.push(fkSQL);
  }

  return { tableSQL, fkSQLs };
}

/**
 * Generate column definition (following Drizzle's pattern)
 */
function generateColumnDefinition(name: string, def: SchemaColumn): string {
  let sql = `"${name}" ${def.type}`;

  // Handle primary key that's not part of composite
  if (def.primaryKey && !def.type.includes("SERIAL")) {
    sql += " PRIMARY KEY";
  }

  // Add NOT NULL constraint
  if (def.notNull) {
    sql += " NOT NULL";
  }

  // Add DEFAULT value - properly formatted
  if (def.default !== undefined) {
    const defaultValue = formatDefaultValue(def.default, def.type);
    sql += ` DEFAULT ${defaultValue}`;
  }

  return sql;
}

/**
 * Generate ALTER TABLE ADD COLUMN SQL
 * Based on Drizzle's PgAlterTableAddColumnConvertor
 */
function generateAddColumnSQL(table: string, column: string, definition: SchemaColumn): string {
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];
  const tableNameWithSchema = `"${schema}"."${tableName}"`;

  // Build column definition parts in the correct order (like Drizzle)
  const parts: string[] = [`"${column}"`];

  // Type
  parts.push(definition.type);

  // Primary key
  if (definition.primaryKey) {
    parts.push("PRIMARY KEY");
  }

  // Default value - needs proper formatting based on type
  if (definition.default !== undefined) {
    const defaultValue = formatDefaultValue(definition.default, definition.type);
    if (defaultValue) {
      parts.push(`DEFAULT ${defaultValue}`);
    }
  }

  // Generated columns
  const definitionWithGenerated = definition as SchemaColumn & {
    generated?: string;
  };
  if (definitionWithGenerated.generated) {
    parts.push(`GENERATED ALWAYS AS (${definitionWithGenerated.generated}) STORED`);
  }

  // NOT NULL constraint - comes after DEFAULT
  if (definition.notNull) {
    parts.push("NOT NULL");
  }

  // IF NOT EXISTS makes this idempotent — important when a column was added by
  // a prior boot whose migration journal/snapshot didn't persist (e.g. crash
  // mid-bootstrap, manual ALTER, or .elizadb reset without journal reset).
  // PostgreSQL 9.6+ and PGlite both support this syntax.
  return `ALTER TABLE ${tableNameWithSchema} ADD COLUMN IF NOT EXISTS ${parts.join(" ")};`;
}

/**
 * Generate ALTER TABLE DROP COLUMN SQL
 * Based on Drizzle's approach with CASCADE
 */
function generateDropColumnSQL(table: string, column: string): string {
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];
  const tableNameWithSchema = `"${schema}"."${tableName}"`;
  // IF EXISTS for the same idempotency reasons as ADD COLUMN above.
  return `ALTER TABLE ${tableNameWithSchema} DROP COLUMN IF EXISTS "${column}" CASCADE;`;
}

// Column change tracking interface
interface ColumnChangeInfo {
  from?: SchemaColumn;
  to?: SchemaColumn;
}

/**
 * Generate ALTER TABLE ALTER COLUMN SQL
 * Based on Drizzle's approach with proper type casting and handling
 */
function generateAlterColumnSQL(
  table: string,
  column: string,
  changes: ColumnChangeInfo
): string[] {
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];
  const tableNameWithSchema = `"${schema}"."${tableName}"`;
  const statements: string[] = [];

  // Handle type changes - need to handle enums and complex types
  const changesTo = changes.to;
  const changesFrom = changes.from;
  const changesToType = changesTo?.type;
  const changesFromType = changesFrom?.type;
  if (changesToType !== changesFromType) {
    const newType = changesToType || "TEXT";

    // Check if we need a USING clause for type conversion
    const needsUsing = checkIfNeedsUsingClause(changesFromType || "", newType);

    if (needsUsing) {
      // For complex type changes, use USING clause like Drizzle
      statements.push(
        `ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" TYPE ${newType} USING ${buildUsingExpression(column, changesFromType || "", newType)};`
      );
    } else {
      statements.push(
        `ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" SET DATA TYPE ${newType};`
      );
    }
  }

  // Handle NOT NULL changes
  const changesToNotNull = changesTo?.notNull;
  const changesFromNotNull = changesFrom?.notNull;
  if (changesToNotNull !== changesFromNotNull) {
    if (changesToNotNull) {
      // When adding NOT NULL, might need to set defaults for existing NULL values
      statements.push(`ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" SET NOT NULL;`);
    } else {
      statements.push(`ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" DROP NOT NULL;`);
    }
  }

  // Handle default value changes
  const changesToDefault = changesTo?.default;
  const changesFromDefault = changesFrom?.default;
  if (changesToDefault !== changesFromDefault) {
    if (changesToDefault !== undefined) {
      const defaultValue = formatDefaultValue(changesToDefault, changesToType || "");
      statements.push(
        `ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" SET DEFAULT ${defaultValue};`
      );
    } else {
      statements.push(`ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" DROP DEFAULT;`);
    }
  }

  return statements;
}

/**
 * Build the USING expression for an ALTER COLUMN TYPE conversion.
 *
 * The generic `::text::<target>` bridge works for most conversions, but
 * Postgres rejects boolean text ('true'/'false') as integer input, so
 * boolean→integer must use the native cast (true→1, false→0) instead.
 */
function buildUsingExpression(column: string, fromType: string, toType: string): string {
  const from = fromType.split("(")[0].toLowerCase().trim();
  const to = toType.split("(")[0].toLowerCase().trim();
  if (from === "boolean" && to === "integer") {
    return `"${column}"::${toType}`;
  }
  return `"${column}"::text::${toType}`;
}

/**
 * Check if a type change needs a USING clause
 * Based on Drizzle's type conversion logic
 */
function checkIfNeedsUsingClause(fromType: string, toType: string): boolean {
  if (!fromType || !toType) return false;

  // Enum changes always need USING
  if (fromType.includes("enum") || toType.includes("enum")) {
    return true;
  }

  // Postgres introspection reports the canonical "character varying";
  // normalize to "varchar" so the pairs below (e.g. varchar→uuid) match.
  // Without this, an ALTER COLUMN id TYPE uuid is emitted without a USING
  // clause and Postgres rejects it ("cannot be cast automatically").
  const normalizeType = (t: string) => {
    const base = t.split("(")[0].toLowerCase().trim();
    return base === "character varying" ? "varchar" : base;
  };
  const fromBase = normalizeType(fromType);
  const toBase = normalizeType(toType);

  // Text/varchar to JSONB always needs USING
  if (
    (fromBase === "text" || fromBase === "varchar") &&
    (toBase === "jsonb" || toBase === "json")
  ) {
    return true;
  }

  // Some specific type conversions need USING
  const needsUsingPairs = [
    ["integer", "boolean"],
    ["boolean", "integer"],
    ["text", "integer"],
    ["text", "numeric"],
    ["text", "boolean"],
    ["text", "uuid"],
    ["text", "jsonb"],
    ["text", "json"],
    ["varchar", "integer"],
    ["varchar", "numeric"],
    ["varchar", "boolean"],
    ["varchar", "uuid"],
    ["varchar", "jsonb"],
    ["varchar", "json"],
    // Add more as needed based on PostgreSQL casting rules
  ];

  for (const [from, to] of needsUsingPairs) {
    if ((fromBase === from && toBase === to) || (fromBase === to && toBase === from)) {
      return true;
    }
  }

  return false;
}

// Default value type - can be string, number, boolean, or null
type DefaultValue = string | number | boolean | null | undefined;

/**
 * Format a default value for SQL
 * Based on Drizzle's default value formatting
 */
function formatDefaultValue(value: DefaultValue, type: string): string {
  // Handle NULL
  if (value === null || value === "NULL") {
    return "NULL";
  }

  // Handle boolean
  if (type && (type.toLowerCase().includes("boolean") || type.toLowerCase() === "bool")) {
    if (value === true || value === "true" || value === "t" || value === 1) {
      return "true";
    }
    if (value === false || value === "false" || value === "f" || value === 0) {
      return "false";
    }
  }

  // Handle numeric types
  if (type.match(/^(integer|bigint|smallint|numeric|decimal|real|double)/i)) {
    return String(value);
  }

  // Handle SQL expressions and pre-formatted defaults
  if (typeof value === "string") {
    // Already formatted with type cast (e.g., '[]'::jsonb, '{}'::jsonb)
    // These come from the snapshot and are already properly formatted
    if (value.includes("::")) {
      return value;
    }

    // Already quoted string literals (from snapshot)
    // These start and end with single quotes
    if (value.startsWith("'") && value.endsWith("'")) {
      return value;
    }

    // SQL functions like now(), gen_random_uuid(), etc.
    if (value.match(/^\w+\(\)/i) || (value.includes("(") && value.includes(")"))) {
      return value;
    }

    // SQL expressions starting with CURRENT_
    if (value.toUpperCase().startsWith("CURRENT_")) {
      return value;
    }

    // Otherwise, it's an unquoted string literal - wrap and escape
    return `'${value.replace(/'/g, "''")}'`;
  }

  // Default: return as-is
  return String(value);
}

// Extended index interface with table reference
interface SchemaIndexWithTableRef {
  name: string;
  columns: Array<{
    expression: string;
    isExpression: boolean;
    asc?: boolean;
    nulls?: string;
  }>;
  isUnique: boolean;
  method?: string;
  where?: string;
  concurrently?: boolean;
  table?: string;
}

/**
 * Generate CREATE INDEX SQL
 */
function generateCreateIndexSQL(index: SchemaIndexWithTableRef): string {
  const unique = index.isUnique ? "UNIQUE " : "";
  const method = index.method || "btree";
  const columns = index.columns
    .map((c) => {
      if (c.isExpression) {
        return c.expression;
      }
      // Only add DESC if explicitly set to false, no NULLS clause by default
      return `"${c.expression}"${c.asc === false ? " DESC" : ""}`;
    })
    .join(", ");

  // Extract index name and table with proper schema handling
  const indexName = index.name.includes(".") ? index.name.split(".")[1] : index.name;

  // Keep the full table name with schema if present
  let tableRef: string;
  const indexTable = index.table;
  if (indexTable?.includes(".")) {
    const [schema, table] = indexTable.split(".");
    tableRef = `"${schema}"."${table}"`;
  } else {
    tableRef = `"${indexTable || ""}"`;
  }

  // Include schema in table reference for correct index creation
  return `CREATE ${unique}INDEX IF NOT EXISTS "${indexName}" ON ${tableRef} USING ${method} (${columns});`;
}

/**
 * Generate DROP INDEX SQL
 */
function generateDropIndexSQL(index: SchemaIndex | string): string {
  // Extract just the index name without schema
  const indexNameFull = typeof index === "string" ? index : index.name;
  const indexName = indexNameFull.includes(".") ? indexNameFull.split(".")[1] : indexNameFull;
  // Match Drizzle's format - no schema qualification
  return `DROP INDEX IF EXISTS "${indexName}";`;
}

/**
 * Generate CREATE FOREIGN KEY SQL (for existing tables)
 */
function generateCreateForeignKeySQL(fk: SchemaForeignKey): string {
  return wrapConstraintCreationGuard(fk.name, buildCreateForeignKeyBodySQL(fk));
}

/**
 * Generate DROP FOREIGN KEY SQL
 */
function generateDropForeignKeySQL(fk: SchemaForeignKey): string {
  const [schema, tableName] = fk.tableFrom
    ? fk.tableFrom.includes(".")
      ? fk.tableFrom.split(".")
      : ["public", fk.tableFrom]
    : ["public", ""];
  return `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT "${fk.name}";`;
}

/**
 * Generate SQL for renaming a table
 */
export function generateRenameTableSQL(oldName: string, newName: string): string {
  const [oldSchema, oldTable] = oldName.includes(".") ? oldName.split(".") : ["public", oldName];
  const [, newTable] = newName.includes(".") ? newName.split(".") : ["public", newName];
  return `ALTER TABLE "${oldSchema}"."${oldTable}" RENAME TO "${newTable}";`;
}

/**
 * Generate SQL for renaming a column
 */
export function generateRenameColumnSQL(table: string, oldName: string, newName: string): string {
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];
  return `ALTER TABLE "${schema}"."${tableName}" RENAME COLUMN "${oldName}" TO "${newName}";`;
}

// Extended constraint interfaces with table reference
interface UniqueConstraintWithTable extends SchemaUniqueConstraint {
  table?: string;
}

interface CheckConstraintWithTable extends SchemaCheckConstraint {
  table?: string;
}

/**
 * Generate CREATE UNIQUE CONSTRAINT SQL
 */
function generateCreateUniqueConstraintSQL(constraint: UniqueConstraintWithTable): string {
  const table = constraint.table || "";
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];

  const name = constraint.name;
  const columns = constraint.columns.map((c) => `"${c}"`).join(", ");

  let sql = `ALTER TABLE "${schema}"."${tableName}" ADD CONSTRAINT "${name}" UNIQUE`;

  // Handle NULLS NOT DISTINCT if specified (PostgreSQL 15+)
  if (constraint.nullsNotDistinct) {
    sql += ` NULLS NOT DISTINCT`;
  }

  sql += ` (${columns});`;

  return sql;
}

/**
 * Generate DROP UNIQUE CONSTRAINT SQL
 */
function generateDropUniqueConstraintSQL(constraint: UniqueConstraintWithTable): string {
  const table = constraint.table || "";
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];

  return `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT "${constraint.name}";`;
}

/**
 * Generate CREATE CHECK CONSTRAINT SQL
 */
function generateCreateCheckConstraintSQL(constraint: CheckConstraintWithTable): string {
  const table = constraint.table || "";
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];

  const name = constraint.name;
  const value = constraint.value;

  return `ALTER TABLE "${schema}"."${tableName}" ADD CONSTRAINT "${name}" CHECK (${value});`;
}

/**
 * Generate DROP CHECK CONSTRAINT SQL
 */
function generateDropCheckConstraintSQL(constraint: CheckConstraintWithTable): string {
  const table = constraint.table || "";
  const [schema, tableName] = table.includes(".") ? table.split(".") : ["public", table];

  return `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT "${constraint.name}";`;
}

function buildCreateForeignKeyBodySQL(fk: SchemaForeignKey): string {
  const schemaFrom = fk.schemaFrom || "public";
  const schemaTo = fk.schemaTo || "public";
  const tableFrom = fk.tableFrom;
  const columnsFrom = fk.columnsFrom.map((c: string) => `"${c}"`).join(", ");
  const columnsTo = fk.columnsTo.map((c: string) => `"${c}"`).join(", ");

  let sql = `ALTER TABLE "${schemaFrom}"."${tableFrom}" ADD CONSTRAINT "${fk.name}" FOREIGN KEY (${columnsFrom}) REFERENCES "${schemaTo}"."${fk.tableTo}" (${columnsTo})`;

  if (fk.onDelete) {
    sql += ` ON DELETE ${fk.onDelete}`;
  }

  if (fk.onUpdate) {
    sql += ` ON UPDATE ${fk.onUpdate}`;
  }

  return sql;
}

function wrapConstraintCreationGuard(constraintName: string, statement: string): string {
  const escapedConstraintName = constraintName.replace(/'/g, "''");
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${escapedConstraintName}') THEN ${statement}; END IF; END $$;`;
}
