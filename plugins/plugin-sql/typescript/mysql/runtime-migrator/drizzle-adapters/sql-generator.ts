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
 * Based on Drizzle's mysqlPushUtils approach
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

// ─── Identifier / table-name helpers ────────────────────────────────────────

/**
 * Quote a MySQL identifier with backticks.
 */
function quoteId(name: string): string {
  return `\`${name}\``;
}

/**
 * Split a possibly schema-qualified name (`db.table` or just `table`) and
 * return a fully-quoted MySQL table reference.
 *
 * MySQL has no "public" schema – if the schema portion equals the empty
 * string we emit only the table name.
 */
function quoteTableName(fullName: string): string {
  if (fullName.includes(".")) {
    const [schema, table] = fullName.split(".");
    if (schema) {
      return `${quoteId(schema)}.${quoteId(table)}`;
    }
    return quoteId(table);
  }
  return quoteId(fullName);
}

/**
 * Extract the raw (unquoted) schema and table from a possibly-qualified name.
 */
function splitTableName(fullName: string): { schema: string; table: string } {
  if (fullName.includes(".")) {
    const [schema, table] = fullName.split(".");
    return { schema: schema || "", table };
  }
  return { schema: "", table: fullName };
}

// ─── Data-loss detection ────────────────────────────────────────────────────

/**
 * Check for potential data loss in schema changes
 * Based on Drizzle's mysqlSuggestions function
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

  // Check for table deletions
  if (diff.tables.deleted.length > 0) {
    result.hasDataLoss = true;
    result.requiresConfirmation = true;
    result.tablesToRemove = [...diff.tables.deleted];
    for (const table of diff.tables.deleted) {
      result.warnings.push(`Table \`${table}\` will be dropped with all its data`);
    }
  }

  // Check for column deletions
  if (diff.columns.deleted.length > 0) {
    result.hasDataLoss = true;
    result.requiresConfirmation = true;
    for (const col of diff.columns.deleted) {
      result.columnsToRemove.push(`${col.table}.${col.column}`);
      result.warnings.push(`Column \`${col.column}\` in table \`${col.table}\` will be dropped`);
    }
  }

  // Check for column type changes that might cause data loss
  for (const modified of diff.columns.modified) {
    const from = modified.changes.from;
    const to = modified.changes.to;

    if (!from || !to) continue;

    // Check if type change is destructive
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
          `Column \`${modified.column}\` in table \`${modified.table}\` changes type from "${from.type}" to "${to.type}". ` +
            `This may require truncating the table to avoid data conversion errors.`
        );
      }
    }

    // Check for adding NOT NULL without default to existing column
    if (!from.notNull && to.notNull && !to.default) {
      result.hasDataLoss = true;
      result.requiresConfirmation = true;
      result.warnings.push(
        `Column \`${modified.column}\` in table \`${modified.table}\` is becoming NOT NULL without a default value. ` +
          `This will fail if the table contains NULL values.`
      );
    }
  }

  // Check for adding NOT NULL columns without defaults
  for (const added of diff.columns.added) {
    if (added.definition.notNull && !added.definition.default) {
      result.warnings.push(
        `Column \`${added.column}\` is being added to table \`${added.table}\` as NOT NULL without a default value. ` +
          `This will fail if the table contains data.`
      );
    }
  }

  return result;
}

// ─── Type normalisation (MySQL) ─────────────────────────────────────────────

/**
 * Normalize MySQL types for comparison.
 * Handles equivalent type variations between the introspected DB and schema
 * definitions so that no-op diffs are not emitted.
 */
function normalizeType(type: string | undefined): string {
  if (!type) return "";

  const normalized = type.toLowerCase().trim();

  // Handle int / integer equivalence
  if (normalized === "integer") {
    return "int";
  }

  // Handle tinyint(1) ↔ boolean equivalence
  if (normalized === "boolean" || normalized === "bool") {
    return "tinyint(1)";
  }

  // Handle numeric/decimal equivalence
  if (normalized.startsWith("numeric") || normalized.startsWith("decimal")) {
    const match = normalized.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (match) {
      return `decimal(${match[1]}${match[2] ? `,${match[2]}` : ""})`;
    }
    return "decimal";
  }

  // Handle double precision → double
  if (normalized === "double precision") {
    return "double";
  }

  // Handle real → float
  if (normalized === "real") {
    return "float";
  }

  // Handle character varying → varchar
  if (normalized.startsWith("character varying")) {
    return normalized.replace("character varying", "varchar");
  }

  // Handle datetime / timestamp equivalence
  // In MySQL, TIMESTAMP and DATETIME are distinct but often used interchangeably
  // Keep them separate for accuracy
  if (normalized === "timestamp without time zone") {
    return "datetime";
  }

  return normalized;
}

/**
 * Check if a type change is destructive.
 * Based on MySQL's implicit type conversion rules.
 */
function checkIfTypeChangeIsDestructive(fromType: string, toType: string): boolean {
  const normalizedFrom = normalizeType(fromType);
  const normalizedTo = normalizeType(toType);

  // If normalised types match it is never destructive
  if (normalizedFrom === normalizedTo) {
    return false;
  }

  // Safe conversions (MySQL)
  const safeConversions: Record<string, string[]> = {
    tinyint: ["smallint", "int", "bigint"],
    "tinyint(1)": ["smallint", "int", "bigint"],
    smallint: ["int", "bigint"],
    int: ["bigint"],
    float: ["double"],
    varchar: ["text"],
    char: ["varchar", "text"],
  };

  const fromBase = normalizedFrom.split("(")[0];
  const toBase = normalizedTo.split("(")[0];

  // Same base type is always safe (e.g. varchar(50) → varchar(255))
  if (fromBase === toBase) {
    return false;
  }

  const safeTo = safeConversions[normalizedFrom] || safeConversions[fromBase];
  if (safeTo?.includes(toBase)) {
    return false;
  }

  // All other conversions are potentially destructive
  return true;
}

// ─── Default-value formatting (MySQL) ───────────────────────────────────────

/** Default value type – can be string, number, boolean, or null */
type DefaultValue = string | number | boolean | null | undefined;

/**
 * Format a default value for MySQL SQL.
 */
function formatDefaultValue(value: DefaultValue, type: string): string {
  // Handle NULL
  if (value === null || value === "NULL") {
    return "NULL";
  }

  // Handle boolean – MySQL uses 1 / 0
  if (
    type &&
    (type.toLowerCase().includes("boolean") ||
      type.toLowerCase() === "bool" ||
      type.toLowerCase() === "tinyint(1)")
  ) {
    if (value === true || value === "true" || value === "t" || value === 1) {
      return "1";
    }
    if (value === false || value === "false" || value === "f" || value === 0) {
      return "0";
    }
  }

  // Handle numeric types
  if (
    type?.match(/^(int|integer|bigint|smallint|tinyint|mediumint|numeric|decimal|float|double)/i)
  ) {
    return String(value);
  }

  // Handle SQL expressions and pre-formatted defaults
  if (typeof value === "string") {
    // PostgreSQL-style type casts (::) – strip them for MySQL
    if (value.includes("::")) {
      // e.g.  '[]'::jsonb  →  ('[]')
      const stripped = value.split("::")[0];
      // If it's already a quoted string, parenthesise for MySQL expression default
      if (stripped.startsWith("'") && stripped.endsWith("'")) {
        return `(${stripped})`;
      }
      return stripped;
    }

    // Already quoted string literals (from snapshot)
    if (value.startsWith("'") && value.endsWith("'")) {
      return value;
    }

    // SQL functions – e.g. NOW(), UUID(), CURRENT_TIMESTAMP
    if (value.match(/^\w+\(\)/i) || (value.includes("(") && value.includes(")"))) {
      return value;
    }

    // SQL expressions starting with CURRENT_
    if (value.toUpperCase().startsWith("CURRENT_")) {
      return value;
    }

    // Unquoted string literal – wrap and escape
    return `'${value.replace(/'/g, "''")}'`;
  }

  // Default: return as-is
  return String(value);
}

// ─── Main migration SQL generator ──────────────────────────────────────────

/**
 * Generate SQL statements from a schema diff.
 * Follows Drizzle's approach: create all tables first, then add foreign keys.
 */
export async function generateMigrationSQL(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot,
  diff?: SchemaDiff
): Promise<string[]> {
  const statements: string[] = [];

  // If no diff provided, calculate it
  if (!diff) {
    const { calculateDiff } = await import("./diff-calculator");
    diff = await calculateDiff(previousSnapshot, currentSnapshot);
  }

  // Check for data loss
  const dataLossCheck = checkForDataLoss(diff);

  // Log warnings if any
  if (dataLossCheck.warnings.length > 0) {
    logger.warn(
      { src: "plugin:mysql", warnings: dataLossCheck.warnings },
      "Schema changes may cause data loss"
    );
  }

  // Phase 1: MySQL has databases instead of schemas – skip CREATE SCHEMA.
  // (If you need cross-database references, CREATE DATABASE should be
  //  handled outside the migration system.)

  // Phase 2: Generate CREATE TABLE statements for new tables (WITHOUT foreign keys)
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

  // Add all CREATE TABLE statements
  statements.push(...createTableStatements);

  // Phase 3: Add all foreign keys AFTER tables are created
  // De-duplicate foreign key statements to avoid duplicate constraints
  const uniqueFKs = new Set<string>();
  const dedupedFKStatements: string[] = [];

  for (const fkSQL of foreignKeyStatements) {
    const match = fkSQL.match(/ADD CONSTRAINT `([^`]+)`/);
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

  // Phase 4: Handle table modifications

  // Generate DROP TABLE statements for deleted tables.
  // MySQL does not support CASCADE on DROP TABLE – disable FK checks instead.
  if (diff.tables.deleted.length > 0) {
    statements.push("SET FOREIGN_KEY_CHECKS = 0;");
    for (const tableName of diff.tables.deleted) {
      statements.push(`DROP TABLE IF EXISTS ${quoteTableName(tableName)};`);
    }
    statements.push("SET FOREIGN_KEY_CHECKS = 1;");
  }

  // Generate ALTER TABLE statements for column changes
  // Handle column additions
  for (const added of diff.columns.added) {
    statements.push(generateAddColumnSQL(added.table, added.column, added.definition));
  }

  // Handle column deletions
  for (const deleted of diff.columns.deleted) {
    statements.push(generateDropColumnSQL(deleted.table, deleted.column));
  }

  // Handle column modifications
  for (const modified of diff.columns.modified) {
    const alterStatements = generateAlterColumnSQL(
      modified.table,
      modified.column,
      modified.changes
    );
    statements.push(...alterStatements);
  }

  // Generate DROP INDEX statements (including altered ones – drop old version)
  for (const index of diff.indexes.deleted) {
    statements.push(generateDropIndexSQL(index));
  }

  // Drop old version of altered indexes
  for (const alteredIndex of diff.indexes.altered) {
    statements.push(generateDropIndexSQL(alteredIndex.old));
  }

  // Generate CREATE INDEX statements (including altered ones – create new version)
  for (const index of diff.indexes.created) {
    statements.push(generateCreateIndexSQL(index));
  }

  // Create new version of altered indexes
  for (const alteredIndex of diff.indexes.altered) {
    statements.push(generateCreateIndexSQL(alteredIndex.new));
  }

  // Generate CREATE UNIQUE CONSTRAINT statements
  for (const constraint of diff.uniqueConstraints.created) {
    const isNewTable = diff.tables.created.some((tableName) => {
      const { table } = splitTableName(tableName);
      const constraintTable =
        (constraint as SchemaUniqueConstraint & { table?: string }).table || "";
      const { table: constraintTableName } = splitTableName(constraintTable);
      return table === constraintTableName;
    });

    if (!isNewTable) {
      statements.push(generateCreateUniqueConstraintSQL(constraint));
    }
  }

  // Generate DROP UNIQUE CONSTRAINT statements
  for (const constraint of diff.uniqueConstraints.deleted) {
    statements.push(generateDropUniqueConstraintSQL(constraint));
  }

  // Generate CREATE CHECK CONSTRAINT statements (MySQL 8.0.16+)
  for (const constraint of diff.checkConstraints.created) {
    const isNewTable = diff.tables.created.some((tableName) => {
      const { table } = splitTableName(tableName);
      const constraintTable =
        (constraint as SchemaCheckConstraint & { table?: string }).table || "";
      const { table: constraintTableName } = splitTableName(constraintTable);
      return table === constraintTableName;
    });

    if (!isNewTable) {
      statements.push(generateCreateCheckConstraintSQL(constraint));
    }
  }

  // Generate DROP CHECK CONSTRAINT statements
  for (const constraint of diff.checkConstraints.deleted) {
    statements.push(generateDropCheckConstraintSQL(constraint));
  }

  // Handle foreign key deletions first (including altered ones)
  for (const fk of diff.foreignKeys.deleted) {
    statements.push(generateDropForeignKeySQL(fk));
  }

  // Drop old version of altered foreign keys
  for (const alteredFK of diff.foreignKeys.altered) {
    statements.push(generateDropForeignKeySQL(alteredFK.old));
  }

  // Handle foreign key creations (for existing tables)
  for (const fk of diff.foreignKeys.created) {
    const tableFrom = fk.tableFrom || "";
    const schemaFrom = fk.schemaFrom || "";

    const isNewTable = diff.tables.created.some((tableName) => {
      const { schema: createdSchema, table: createdTable } = splitTableName(tableName);
      return createdTable === tableFrom && createdSchema === schemaFrom;
    });

    if (!isNewTable) {
      statements.push(generateCreateForeignKeySQL(fk));
    }
  }

  // Create new version of altered foreign keys
  for (const alteredFK of diff.foreignKeys.altered) {
    statements.push(generateCreateForeignKeySQL(alteredFK.new));
  }

  return statements;
}

// ─── CREATE TABLE (MySQL) ───────────────────────────────────────────────────

/**
 * Generate CREATE TABLE SQL (following Drizzle's pattern).
 * Returns the table creation SQL and separate foreign key SQLs.
 */
function generateCreateTableSQL(
  fullTableName: string,
  table: SchemaTable
): { tableSQL: string; fkSQLs: string[] } {
  const quotedTable = quoteTableName(fullTableName);
  const columns: string[] = [];
  const fkSQLs: string[] = [];

  // Add columns
  for (const [colName, colDef] of Object.entries(table.columns || {})) {
    columns.push(generateColumnDefinition(colName, colDef));
  }

  // Add composite primary keys
  const primaryKeys = table.compositePrimaryKeys || {};
  for (const [pkName, pkDef] of Object.entries(primaryKeys)) {
    const pk = pkDef as SchemaPrimaryKey;
    if (pk.columns && pk.columns.length > 0) {
      columns.push(
        `CONSTRAINT ${quoteId(pkName)} PRIMARY KEY (${pk.columns.map((c) => quoteId(c)).join(", ")})`
      );
    }
  }

  // Add unique constraints
  // MySQL does not support NULLS NOT DISTINCT – omit that clause.
  const uniqueConstraints = table.uniqueConstraints || {};
  for (const [uqName, uqDef] of Object.entries(uniqueConstraints)) {
    const uq = uqDef as SchemaUniqueConstraint;
    if (uq.columns && uq.columns.length > 0) {
      columns.push(
        `CONSTRAINT ${quoteId(uqName)} UNIQUE (${uq.columns.map((c) => quoteId(c)).join(", ")})`
      );
    }
  }

  // Add check constraints (MySQL 8.0.16+)
  const checkConstraints = table.checkConstraints || {};
  for (const [checkName, checkDef] of Object.entries(checkConstraints)) {
    const check = checkDef as SchemaCheckConstraint;
    if (check.value) {
      columns.push(`CONSTRAINT ${quoteId(checkName)} CHECK (${check.value})`);
    }
  }

  const tableSQL = `CREATE TABLE IF NOT EXISTS ${quotedTable} (\n  ${columns.join(",\n  ")}\n);`;

  // Collect foreign keys to be added AFTER all tables are created
  const foreignKeys = table.foreignKeys || {};
  for (const [fkName, fkDef] of Object.entries(foreignKeys)) {
    const fk = fkDef as SchemaForeignKey;

    const refTable = fk.schemaTo
      ? `${quoteId(fk.schemaTo)}.${quoteId(fk.tableTo)}`
      : quoteId(fk.tableTo);

    const fkSQL =
      `ALTER TABLE ${quotedTable} ADD CONSTRAINT ${quoteId(fkName)} FOREIGN KEY (${fk.columnsFrom.map((c) => quoteId(c)).join(", ")}) REFERENCES ${refTable} (${fk.columnsTo.map((c) => quoteId(c)).join(", ")})` +
      `${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ""}` +
      `${fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : ""};`;
    fkSQLs.push(fkSQL);
  }

  return { tableSQL, fkSQLs };
}

// ─── Column definition (MySQL) ──────────────────────────────────────────────

/**
 * Generate a single column definition inside CREATE TABLE.
 */
function generateColumnDefinition(name: string, def: SchemaColumn): string {
  let colType = def.type;

  // MySQL uses AUTO_INCREMENT instead of SERIAL
  const upperType = colType.toUpperCase();
  if (upperType === "SERIAL") {
    colType = "BIGINT AUTO_INCREMENT";
  } else if (upperType === "SMALLSERIAL") {
    colType = "SMALLINT AUTO_INCREMENT";
  } else if (upperType === "BIGSERIAL") {
    colType = "BIGINT AUTO_INCREMENT";
  }

  let sql = `${quoteId(name)} ${colType}`;

  // Handle primary key that is not part of a composite
  if (def.primaryKey) {
    sql += " PRIMARY KEY";
  }

  // Add NOT NULL constraint
  if (def.notNull) {
    sql += " NOT NULL";
  }

  // Add DEFAULT value
  if (def.default !== undefined) {
    const defaultValue = formatDefaultValue(def.default, def.type);
    sql += ` DEFAULT ${defaultValue}`;
  }

  return sql;
}

// ─── ADD / DROP / ALTER COLUMN (MySQL) ──────────────────────────────────────

/**
 * Generate ALTER TABLE ADD COLUMN SQL.
 */
function generateAddColumnSQL(table: string, column: string, definition: SchemaColumn): string {
  const quotedTable = quoteTableName(table);

  let colType = definition.type;
  const upperType = colType.toUpperCase();
  if (upperType === "SERIAL") {
    colType = "BIGINT AUTO_INCREMENT";
  } else if (upperType === "SMALLSERIAL") {
    colType = "SMALLINT AUTO_INCREMENT";
  } else if (upperType === "BIGSERIAL") {
    colType = "BIGINT AUTO_INCREMENT";
  }

  const parts: string[] = [quoteId(column)];

  // Type
  parts.push(colType);

  // Primary key
  if (definition.primaryKey) {
    parts.push("PRIMARY KEY");
  }

  // Default value
  if (definition.default !== undefined) {
    const defaultValue = formatDefaultValue(definition.default, definition.type);
    if (defaultValue) {
      parts.push(`DEFAULT ${defaultValue}`);
    }
  }

  // Generated columns
  const definitionWithGenerated = definition as SchemaColumn & { generated?: string };
  if (definitionWithGenerated.generated) {
    parts.push(`GENERATED ALWAYS AS (${definitionWithGenerated.generated}) STORED`);
  }

  // NOT NULL constraint – comes after DEFAULT
  if (definition.notNull) {
    parts.push("NOT NULL");
  }

  return `ALTER TABLE ${quotedTable} ADD COLUMN ${parts.join(" ")};`;
}

/**
 * Generate ALTER TABLE DROP COLUMN SQL.
 * MySQL does not support CASCADE on DROP COLUMN.
 */
function generateDropColumnSQL(table: string, column: string): string {
  return `ALTER TABLE ${quoteTableName(table)} DROP COLUMN ${quoteId(column)};`;
}

// Column change tracking interface
interface ColumnChangeInfo {
  from?: SchemaColumn;
  to?: SchemaColumn;
}

/**
 * Generate ALTER TABLE statements for column modifications.
 *
 * MySQL requires MODIFY COLUMN with the full column definition for type or
 * nullability changes.  Default-only changes can use the lighter
 * ALTER COLUMN ... SET DEFAULT / DROP DEFAULT syntax.
 */
function generateAlterColumnSQL(
  table: string,
  column: string,
  changes: ColumnChangeInfo
): string[] {
  const quotedTable = quoteTableName(table);
  const statements: string[] = [];

  const changesTo = changes.to;
  const changesFrom = changes.from;

  const changesToType = changesTo?.type;
  const changesFromType = changesFrom?.type;
  const changesToNotNull = changesTo?.notNull;
  const changesFromNotNull = changesFrom?.notNull;
  const changesToDefault = changesTo?.default;
  const changesFromDefault = changesFrom?.default;

  const typeChanged = changesToType !== changesFromType;
  const notNullChanged = changesToNotNull !== changesFromNotNull;
  const defaultChanged = changesToDefault !== changesFromDefault;

  if (typeChanged || notNullChanged) {
    // MODIFY COLUMN requires the full column definition.
    // We always use the target ("to") state so every attribute is correct.
    let colType = changesToType || changesFromType || "TEXT";

    // Handle SERIAL → AUTO_INCREMENT
    const upper = colType.toUpperCase();
    if (upper === "SERIAL") {
      colType = "BIGINT AUTO_INCREMENT";
    } else if (upper === "SMALLSERIAL") {
      colType = "SMALLINT AUTO_INCREMENT";
    } else if (upper === "BIGSERIAL") {
      colType = "BIGINT AUTO_INCREMENT";
    }

    let modifySql = `ALTER TABLE ${quotedTable} MODIFY COLUMN ${quoteId(column)} ${colType}`;

    if (changesToNotNull) {
      modifySql += " NOT NULL";
    }

    // Carry over default from the target column definition
    const effectiveDefault = defaultChanged ? changesToDefault : changesFromDefault;
    if (effectiveDefault !== undefined) {
      const defaultValue = formatDefaultValue(effectiveDefault, changesToType || "");
      modifySql += ` DEFAULT ${defaultValue}`;
    }

    statements.push(`${modifySql};`);
  } else if (defaultChanged) {
    // Only the default value changed – use the lighter ALTER COLUMN syntax
    if (changesToDefault !== undefined) {
      const defaultValue = formatDefaultValue(changesToDefault, changesToType || "");
      statements.push(
        `ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteId(column)} SET DEFAULT ${defaultValue};`
      );
    } else {
      statements.push(`ALTER TABLE ${quotedTable} ALTER COLUMN ${quoteId(column)} DROP DEFAULT;`);
    }
  }

  return statements;
}

// ─── Indexes (MySQL) ────────────────────────────────────────────────────────

// Extended index interface with table reference
interface SchemaIndexWithTableRef {
  name: string;
  columns: Array<{ expression: string; isExpression: boolean; asc?: boolean; nulls?: string }>;
  isUnique: boolean;
  method?: string;
  where?: string;
  concurrently?: boolean;
  table?: string;
}

/**
 * Generate CREATE INDEX SQL for MySQL.
 * MySQL does not support CONCURRENTLY or partial (WHERE) indexes.
 */
function generateCreateIndexSQL(index: SchemaIndexWithTableRef): string {
  const unique = index.isUnique ? "UNIQUE " : "";

  const columns = index.columns
    .map((c) => {
      if (c.isExpression) {
        return c.expression;
      }
      return `${quoteId(c.expression)}${c.asc === false ? " DESC" : ""}`;
    })
    .join(", ");

  // Extract index name (strip schema prefix if present)
  const indexName = index.name.includes(".") ? index.name.split(".")[1] : index.name;

  // Resolve table reference
  const indexTable = index.table || "";
  const tableRef = quoteTableName(indexTable);

  // MySQL USING clause comes after column list
  const method =
    index.method && index.method.toLowerCase() !== "btree" ? ` USING ${index.method}` : "";

  return `CREATE ${unique}INDEX ${quoteId(indexName)} ON ${tableRef} (${columns})${method};`;
}

/**
 * Generate DROP INDEX SQL for MySQL.
 * MySQL requires ON table_name for DROP INDEX.
 */
function generateDropIndexSQL(index: SchemaIndex | (SchemaIndex & { table?: string })): string {
  const indexObj = typeof index === "string" ? null : index;
  const indexNameFull = indexObj ? indexObj.name : (index as unknown as string);
  const indexName = indexNameFull.includes(".") ? indexNameFull.split(".")[1] : indexNameFull;

  // Attempt to resolve the table from the index object
  const tableRef = (indexObj as SchemaIndex & { table?: string })?.table;

  if (tableRef) {
    return `DROP INDEX ${quoteId(indexName)} ON ${quoteTableName(tableRef)};`;
  }

  // Fallback: MySQL requires ON table, but if we don't have one, emit the
  // best-effort statement (will need manual fixup if table is unknown).
  logger.warn(
    { src: "plugin:mysql", index: indexName },
    "DROP INDEX generated without table reference – MySQL requires ON <table>"
  );
  return `DROP INDEX ${quoteId(indexName)};`;
}

// ─── Foreign keys (MySQL) ───────────────────────────────────────────────────

/**
 * Generate ALTER TABLE ADD CONSTRAINT … FOREIGN KEY SQL.
 */
function generateCreateForeignKeySQL(fk: SchemaForeignKey): string {
  const tableFrom = fk.schemaFrom
    ? `${quoteId(fk.schemaFrom)}.${quoteId(fk.tableFrom)}`
    : quoteId(fk.tableFrom);

  const tableTo = fk.schemaTo
    ? `${quoteId(fk.schemaTo)}.${quoteId(fk.tableTo)}`
    : quoteId(fk.tableTo);

  const columnsFrom = fk.columnsFrom.map((c: string) => quoteId(c)).join(", ");
  const columnsTo = fk.columnsTo.map((c: string) => quoteId(c)).join(", ");

  let sql = `ALTER TABLE ${tableFrom} ADD CONSTRAINT ${quoteId(fk.name)} FOREIGN KEY (${columnsFrom}) REFERENCES ${tableTo} (${columnsTo})`;

  if (fk.onDelete) {
    sql += ` ON DELETE ${fk.onDelete}`;
  }

  if (fk.onUpdate) {
    sql += ` ON UPDATE ${fk.onUpdate}`;
  }

  return `${sql};`;
}

/**
 * Generate ALTER TABLE DROP FOREIGN KEY SQL.
 * MySQL uses DROP FOREIGN KEY (not DROP CONSTRAINT) for FK removal.
 */
function generateDropForeignKeySQL(fk: SchemaForeignKey): string {
  const tableFrom = fk.tableFrom || "";
  const quotedTable = fk.schemaFrom
    ? `${quoteId(fk.schemaFrom)}.${quoteId(tableFrom)}`
    : quoteId(tableFrom);

  return `ALTER TABLE ${quotedTable} DROP FOREIGN KEY ${quoteId(fk.name)};`;
}

// ─── Unique constraints (MySQL) ─────────────────────────────────────────────

// Extended constraint interfaces with table reference
interface UniqueConstraintWithTable extends SchemaUniqueConstraint {
  table?: string;
}

/**
 * Generate ALTER TABLE ADD UNIQUE INDEX SQL.
 * MySQL does not support NULLS NOT DISTINCT – that clause is silently omitted.
 */
function generateCreateUniqueConstraintSQL(constraint: UniqueConstraintWithTable): string {
  const table = constraint.table || "";
  const quotedTable = quoteTableName(table);

  const name = constraint.name;
  const columns = constraint.columns.map((c) => quoteId(c)).join(", ");

  return `ALTER TABLE ${quotedTable} ADD CONSTRAINT ${quoteId(name)} UNIQUE (${columns});`;
}

/**
 * Generate DROP INDEX for a unique constraint.
 * In MySQL unique constraints are implemented as unique indexes, so we use
 * DROP INDEX … ON … to remove them.
 */
function generateDropUniqueConstraintSQL(constraint: UniqueConstraintWithTable): string {
  const table = constraint.table || "";
  const quotedTable = quoteTableName(table);

  return `DROP INDEX ${quoteId(constraint.name)} ON ${quotedTable};`;
}

// ─── Check constraints (MySQL 8.0.16+) ─────────────────────────────────────

interface CheckConstraintWithTable extends SchemaCheckConstraint {
  table?: string;
}

/**
 * Generate ALTER TABLE ADD CONSTRAINT … CHECK SQL.
 */
function generateCreateCheckConstraintSQL(constraint: CheckConstraintWithTable): string {
  const table = constraint.table || "";
  const quotedTable = quoteTableName(table);

  return `ALTER TABLE ${quotedTable} ADD CONSTRAINT ${quoteId(constraint.name)} CHECK (${constraint.value});`;
}

/**
 * Generate ALTER TABLE DROP CHECK SQL (MySQL 8.0.16+).
 */
function generateDropCheckConstraintSQL(constraint: CheckConstraintWithTable): string {
  const table = constraint.table || "";
  const quotedTable = quoteTableName(table);

  return `ALTER TABLE ${quotedTable} DROP CHECK ${quoteId(constraint.name)};`;
}

// ─── Rename helpers (public) ────────────────────────────────────────────────

/**
 * Generate SQL for renaming a table.
 * MySQL syntax: ALTER TABLE `old` RENAME TO `new`;
 */
export function generateRenameTableSQL(oldName: string, newName: string): string {
  const { table: newTable } = splitTableName(newName);
  return `ALTER TABLE ${quoteTableName(oldName)} RENAME TO ${quoteId(newTable)};`;
}

/**
 * Generate SQL for renaming a column.
 * MySQL syntax: ALTER TABLE `tbl` RENAME COLUMN `old` TO `new`;
 */
export function generateRenameColumnSQL(table: string, oldName: string, newName: string): string {
  return `ALTER TABLE ${quoteTableName(table)} RENAME COLUMN ${quoteId(oldName)} TO ${quoteId(newName)};`;
}
