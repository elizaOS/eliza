import type { SchemaSnapshot } from '../types';
import type { SchemaDiff } from './diff-calculator';
import { logger } from '@elizaos/core';

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

  // Check for table deletions
  if (diff.tables.deleted.length > 0) {
    result.hasDataLoss = true;
    result.requiresConfirmation = true;
    result.tablesToRemove = [...diff.tables.deleted];
    for (const table of diff.tables.deleted) {
      result.warnings.push(`Table "${table}" will be dropped with all its data`);
    }
  }

  // Check for column deletions
  if (diff.columns.deleted.length > 0) {
    result.hasDataLoss = true;
    result.requiresConfirmation = true;
    for (const col of diff.columns.deleted) {
      result.columnsToRemove.push(`${col.table}.${col.column}`);
      result.warnings.push(`Column "${col.column}" in table "${col.table}" will be dropped`);
    }
  }

  // Check for column type changes that might cause data loss
  for (const modified of diff.columns.modified) {
    const from = modified.changes.from;
    const to = modified.changes.to;

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
          `Column "${modified.column}" in table "${modified.table}" changes type from "${from.type}" to "${to.type}". ` +
            `This may require truncating the table to avoid data conversion errors.`
        );
      }
    }

    // Check for adding NOT NULL without default to existing column
    if (!from.notNull && to.notNull && !to.default) {
      result.hasDataLoss = true;
      result.requiresConfirmation = true;
      result.warnings.push(
        `Column "${modified.column}" in table "${modified.table}" is becoming NOT NULL without a default value. ` +
          `This will fail if the table contains NULL values.`
      );
    }
  }

  // Check for adding NOT NULL columns without defaults
  for (const added of diff.columns.added) {
    if (added.definition.notNull && !added.definition.default) {
      // This is only a problem if the table already has data
      // We'll flag it as a potential issue
      result.warnings.push(
        `Column "${added.column}" is being added to table "${added.table}" as NOT NULL without a default value. ` +
          `This will fail if the table contains data.`
      );
      // Don't set requiresConfirmation here - it's only a warning
    }
  }

  return result;
}

/**
 * Normalize SQL types for comparison
 * Handles equivalent type variations between introspected DB and schema definitions
 */
function normalizeType(type: string | undefined): string {
  if (!type) return '';

  const normalized = type.toLowerCase().trim();

  // Handle timestamp variations - all are equivalent
  if (
    normalized === 'timestamp without time zone' ||
    normalized === 'timestamp with time zone' ||
    normalized === 'timestamptz'
  ) {
    return 'timestamp';
  }

  // Handle serial vs integer with identity
  // serial is essentially integer with auto-increment
  if (normalized === 'serial') {
    return 'integer';
  }
  if (normalized === 'bigserial') {
    return 'bigint';
  }
  if (normalized === 'smallserial') {
    return 'smallint';
  }

  // Handle numeric/decimal equivalence
  if (normalized.startsWith('numeric') || normalized.startsWith('decimal')) {
    // Extract precision and scale if present
    const match = normalized.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (match) {
      return `numeric(${match[1]}${match[2] ? `,${match[2]}` : ''})`;
    }
    return 'numeric';
  }

  // Handle varchar/character varying
  if (normalized.startsWith('character varying')) {
    return normalized.replace('character varying', 'varchar');
  }

  // Handle text array variations
  if (normalized === 'text[]' || normalized === '_text') {
    return 'text[]';
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
    smallint: ['integer', 'bigint', 'numeric', 'real', 'double precision'],
    integer: ['bigint', 'numeric', 'real', 'double precision'],
    bigint: ['numeric'],
    real: ['double precision'],
    varchar: ['text'],
    char: ['varchar', 'text'],
    citext: ['text'],
    text: ['citext'],
    // UUID to text is safe
    uuid: ['text', 'varchar'],
    // Timestamp variations are generally safe (now handled by normalization)
    timestamp: ['timestamp'], // Simplified since normalization handles variations
    // Date/time conversions
    date: ['timestamp'],
    time: ['timetz'],
  };

  const fromBase = normalizedFrom.split('(')[0];
  const toBase = normalizedTo.split('(')[0];

  // Same type is always safe
  if (fromBase === toBase) {
    return false;
  }

  // Check if it's a safe conversion
  const safeTo = safeConversions[fromBase];
  if (safeTo && safeTo.includes(toBase)) {
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

  // If no diff provided, calculate it
  if (!diff) {
    const { calculateDiff } = await import('./diff-calculator');
    diff = await calculateDiff(previousSnapshot, currentSnapshot);
  }

  // Check for data loss
  const dataLossCheck = checkForDataLoss(diff);

  // Log warnings if any
  if (dataLossCheck.warnings.length > 0) {
    logger.warn('[RuntimeMigrator] Schema changes may cause data loss:');
    for (const warning of dataLossCheck.warnings) {
      logger.warn(`  - ${warning}`);
    }
  }

  // Phase 1: Collect unique schemas and create them first
  const schemasToCreate = new Set<string>();
  for (const tableName of diff.tables.created) {
    const table = currentSnapshot.tables[tableName];
    if (table) {
      const schema = table.schema || 'public';
      if (schema !== 'public') {
        schemasToCreate.add(schema);
      }
    }
  }

  // Create schemas first (following drizzle-kit pattern)
  for (const schema of schemasToCreate) {
    statements.push(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);
  }

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
  // Deduplicate foreign key statements to avoid duplicate constraints
  const uniqueFKs = new Set<string>();
  const dedupedFKStatements: string[] = [];

  for (const fkSQL of foreignKeyStatements) {
    // Extract constraint name to check for duplicates
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

  // Phase 4: Handle table modifications

  // Generate DROP TABLE statements for deleted tables
  for (const tableName of diff.tables.deleted) {
    const [schema, name] = tableName.includes('.') ? tableName.split('.') : ['public', tableName];
    statements.push(`DROP TABLE IF EXISTS "${schema}"."${name}" CASCADE;`);
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

  // Generate DROP INDEX statements (including altered ones - drop old version)
  for (const index of diff.indexes.deleted) {
    statements.push(generateDropIndexSQL(index));
  }

  // Drop old version of altered indexes
  for (const alteredIndex of diff.indexes.altered) {
    statements.push(generateDropIndexSQL(alteredIndex.old));
  }

  // Generate CREATE INDEX statements (including altered ones - create new version)
  for (const index of diff.indexes.created) {
    statements.push(generateCreateIndexSQL(index));
  }

  // Create new version of altered indexes
  for (const alteredIndex of diff.indexes.altered) {
    statements.push(generateCreateIndexSQL(alteredIndex.new));
  }

  // Generate CREATE UNIQUE CONSTRAINT statements
  for (const constraint of diff.uniqueConstraints.created) {
    // Skip if it's part of a new table (already handled)
    const isNewTable = diff.tables.created.some((tableName) => {
      const [schema, table] = tableName.includes('.')
        ? tableName.split('.')
        : ['public', tableName];
      const constraintTable = constraint.table || '';
      const [constraintSchema, constraintTableName] = constraintTable.includes('.')
        ? constraintTable.split('.')
        : ['public', constraintTable];
      return table === constraintTableName && schema === constraintSchema;
    });

    if (!isNewTable) {
      statements.push(generateCreateUniqueConstraintSQL(constraint));
    }
  }

  // Generate DROP UNIQUE CONSTRAINT statements
  for (const constraint of diff.uniqueConstraints.deleted) {
    statements.push(generateDropUniqueConstraintSQL(constraint));
  }

  // Generate CREATE CHECK CONSTRAINT statements
  for (const constraint of diff.checkConstraints.created) {
    // Skip if it's part of a new table (already handled)
    const isNewTable = diff.tables.created.some((tableName) => {
      const [schema, table] = tableName.includes('.')
        ? tableName.split('.')
        : ['public', tableName];
      const constraintTable = constraint.table || '';
      const [constraintSchema, constraintTableName] = constraintTable.includes('.')
        ? constraintTable.split('.')
        : ['public', constraintTable];
      return table === constraintTableName && schema === constraintSchema;
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
    // Only add if it's not part of a new table (those were handled above)
    // Check both with and without schema prefix
    const tableFrom = fk.tableFrom || '';
    const schemaFrom = fk.schemaFrom || 'public';

    const isNewTable = diff.tables.created.some((tableName) => {
      // Compare table names, handling schema prefixes
      const [createdSchema, createdTable] = tableName.includes('.')
        ? tableName.split('.')
        : ['public', tableName];

      // Compare using the actual schema and table from the FK
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

/**
 * Generate CREATE TABLE SQL (following Drizzle's pattern)
 * Returns the table creation SQL and separate foreign key SQLs
 */
function generateCreateTableSQL(
  fullTableName: string,
  table: any
): { tableSQL: string; fkSQLs: string[] } {
  const [schema, tableName] = fullTableName.includes('.')
    ? fullTableName.split('.')
    : ['public', fullTableName];
  const columns: string[] = [];
  const fkSQLs: string[] = [];

  // Add columns
  for (const [colName, colDef] of Object.entries(table.columns || {})) {
    columns.push(generateColumnDefinition(colName, colDef as any));
  }

  // Add composite primary keys if exists
  const primaryKeys = table.compositePrimaryKeys || {};
  for (const [pkName, pkDef] of Object.entries(primaryKeys)) {
    const pk = pkDef as any;
    if (pk.columns && pk.columns.length > 0) {
      columns.push(
        `CONSTRAINT "${pkName}" PRIMARY KEY (${pk.columns.map((c: string) => `"${c}"`).join(', ')})`
      );
    }
  }

  // Add unique constraints
  const uniqueConstraints = table.uniqueConstraints || {};
  for (const [uqName, uqDef] of Object.entries(uniqueConstraints)) {
    const uq = uqDef as any;
    if (uq.columns && uq.columns.length > 0) {
      const uniqueDef = uq.nullsNotDistinct
        ? `CONSTRAINT "${uqName}" UNIQUE NULLS NOT DISTINCT (${uq.columns.map((c: string) => `"${c}"`).join(', ')})`
        : `CONSTRAINT "${uqName}" UNIQUE (${uq.columns.map((c: string) => `"${c}"`).join(', ')})`;
      columns.push(uniqueDef);
    }
  }

  // Add check constraints
  const checkConstraints = table.checkConstraints || {};
  for (const [checkName, checkDef] of Object.entries(checkConstraints)) {
    const check = checkDef as any;
    if (check.value) {
      columns.push(`CONSTRAINT "${checkName}" CHECK (${check.value})`);
    }
  }

  // Following drizzle-kit pattern: don't create schema here, it's handled separately
  const tableSQL = `CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (\n  ${columns.join(',\n  ')}\n);`;

  // Collect foreign keys to be added AFTER all tables are created
  const foreignKeys = table.foreignKeys || {};
  for (const [fkName, fkDef] of Object.entries(foreignKeys)) {
    const fk = fkDef as any;
    const fkSQL = `ALTER TABLE "${schema}"."${tableName}" ADD CONSTRAINT "${fkName}" FOREIGN KEY (${fk.columnsFrom.map((c: string) => `"${c}"`).join(', ')}) REFERENCES "${fk.schemaTo || 'public'}"."${fk.tableTo}" (${fk.columnsTo.map((c: string) => `"${c}"`).join(', ')})${fk.onDelete ? ` ON DELETE ${fk.onDelete}` : ''}${fk.onUpdate ? ` ON UPDATE ${fk.onUpdate}` : ''};`;
    fkSQLs.push(fkSQL);
  }

  return { tableSQL, fkSQLs };
}

/**
 * Generate column definition (following Drizzle's pattern)
 */
function generateColumnDefinition(name: string, def: any): string {
  let sql = `"${name}" ${def.type}`;

  // Handle primary key that's not part of composite
  if (def.primaryKey && !def.type.includes('SERIAL')) {
    sql += ' PRIMARY KEY';
  }

  // Add NOT NULL constraint
  if (def.notNull) {
    sql += ' NOT NULL';
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
function generateAddColumnSQL(table: string, column: string, definition: any): string {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  const tableNameWithSchema = `"${schema}"."${tableName}"`;

  // Build column definition parts in the correct order (like Drizzle)
  const parts: string[] = [`"${column}"`];

  // Type
  parts.push(definition.type);

  // Primary key
  if (definition.primaryKey) {
    parts.push('PRIMARY KEY');
  }

  // Default value - needs proper formatting based on type
  if (definition.default !== undefined) {
    const defaultValue = formatDefaultValue(definition.default, definition.type);
    if (defaultValue) {
      parts.push(`DEFAULT ${defaultValue}`);
    }
  }

  // Generated columns
  if (definition.generated) {
    parts.push(`GENERATED ALWAYS AS (${definition.generated}) STORED`);
  }

  // NOT NULL constraint - comes after DEFAULT
  if (definition.notNull) {
    parts.push('NOT NULL');
  }

  return `ALTER TABLE ${tableNameWithSchema} ADD COLUMN ${parts.join(' ')};`;
}

/**
 * Generate ALTER TABLE DROP COLUMN SQL
 * Based on Drizzle's approach with CASCADE
 */
function generateDropColumnSQL(table: string, column: string): string {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  const tableNameWithSchema = `"${schema}"."${tableName}"`;
  // Use CASCADE to handle dependent objects
  return `ALTER TABLE ${tableNameWithSchema} DROP COLUMN "${column}" CASCADE;`;
}

/**
 * Generate ALTER TABLE ALTER COLUMN SQL
 * Based on Drizzle's approach with proper type casting and handling
 */
function generateAlterColumnSQL(table: string, column: string, changes: any): string[] {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  const tableNameWithSchema = `"${schema}"."${tableName}"`;
  const statements: string[] = [];

  // Handle type changes - need to handle enums and complex types
  if (changes.to?.type !== changes.from?.type) {
    const newType = changes.to?.type || 'TEXT';

    // Check if we need a USING clause for type conversion
    const needsUsing = checkIfNeedsUsingClause(changes.from?.type, newType);

    if (needsUsing) {
      // For complex type changes, use USING clause like Drizzle
      statements.push(
        `ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" TYPE ${newType} USING "${column}"::text::${newType};`
      );
    } else {
      statements.push(
        `ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" SET DATA TYPE ${newType};`
      );
    }
  }

  // Handle NOT NULL changes
  if (changes.to?.notNull !== changes.from?.notNull) {
    if (changes.to?.notNull) {
      // When adding NOT NULL, might need to set defaults for existing NULL values
      statements.push(`ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" SET NOT NULL;`);
    } else {
      statements.push(`ALTER TABLE ${tableNameWithSchema} ALTER COLUMN "${column}" DROP NOT NULL;`);
    }
  }

  // Handle default value changes
  if (changes.to?.default !== changes.from?.default) {
    if (changes.to?.default !== undefined) {
      const defaultValue = formatDefaultValue(changes.to.default, changes.to?.type);
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
 * Check if a type change needs a USING clause
 * Based on Drizzle's type conversion logic
 */
function checkIfNeedsUsingClause(fromType: string, toType: string): boolean {
  if (!fromType || !toType) return false;

  // Enum changes always need USING
  if (fromType.includes('enum') || toType.includes('enum')) {
    return true;
  }

  const fromBase = fromType.split('(')[0].toLowerCase();
  const toBase = toType.split('(')[0].toLowerCase();

  // Text/varchar to JSONB always needs USING
  if (
    (fromBase === 'text' || fromBase === 'varchar' || fromBase === 'character varying') &&
    (toBase === 'jsonb' || toBase === 'json')
  ) {
    return true;
  }

  // Some specific type conversions need USING
  const needsUsingPairs = [
    ['integer', 'boolean'],
    ['boolean', 'integer'],
    ['text', 'integer'],
    ['text', 'numeric'],
    ['text', 'boolean'],
    ['text', 'uuid'],
    ['text', 'jsonb'],
    ['text', 'json'],
    ['varchar', 'integer'],
    ['varchar', 'numeric'],
    ['varchar', 'boolean'],
    ['varchar', 'uuid'],
    ['varchar', 'jsonb'],
    ['varchar', 'json'],
    ['character varying', 'jsonb'],
    ['character varying', 'json'],
    // Add more as needed based on PostgreSQL casting rules
  ];

  for (const [from, to] of needsUsingPairs) {
    if ((fromBase === from && toBase === to) || (fromBase === to && toBase === from)) {
      return true;
    }
  }

  return false;
}

/**
 * Format a default value for SQL
 * Based on Drizzle's default value formatting
 */
function formatDefaultValue(value: any, type: string): string {
  // Handle NULL
  if (value === null || value === 'NULL') {
    return 'NULL';
  }

  // Handle boolean
  if (type && (type.toLowerCase().includes('boolean') || type.toLowerCase() === 'bool')) {
    if (value === true || value === 'true' || value === 't' || value === 1) {
      return 'true';
    }
    if (value === false || value === 'false' || value === 'f' || value === 0) {
      return 'false';
    }
  }

  // Handle numeric types
  if (type && type.match(/^(integer|bigint|smallint|numeric|decimal|real|double)/i)) {
    return String(value);
  }

  // Handle SQL expressions and pre-formatted defaults
  if (typeof value === 'string') {
    // Already formatted with type cast (e.g., '[]'::jsonb, '{}'::jsonb)
    // These come from the snapshot and are already properly formatted
    if (value.includes('::')) {
      return value;
    }

    // Already quoted string literals (from snapshot)
    // These start and end with single quotes
    if (value.startsWith("'") && value.endsWith("'")) {
      return value;
    }

    // SQL functions like now(), gen_random_uuid(), etc.
    if (value.match(/^\w+\(\)/i) || (value.includes('(') && value.includes(')'))) {
      return value;
    }

    // SQL expressions starting with CURRENT_
    if (value.toUpperCase().startsWith('CURRENT_')) {
      return value;
    }

    // Otherwise, it's an unquoted string literal - wrap and escape
    return `'${value.replace(/'/g, "''")}'`;
  }

  // Default: return as-is
  return String(value);
}

/**
 * Generate CREATE INDEX SQL
 */
function generateCreateIndexSQL(index: any): string {
  const unique = index.isUnique ? 'UNIQUE ' : '';
  const method = index.method || 'btree';
  const columns = index.columns
    .map((c: any) => {
      if (c.isExpression) {
        return c.expression;
      }
      // Only add DESC if explicitly set to false, no NULLS clause by default
      return `"${c.expression}"${c.asc === false ? ' DESC' : ''}`;
    })
    .join(', ');

  // Extract index name and table with proper schema handling
  const indexName = index.name.includes('.') ? index.name.split('.')[1] : index.name;

  // Keep the full table name with schema if present
  let tableRef: string;
  if (index.table && index.table.includes('.')) {
    const [schema, table] = index.table.split('.');
    tableRef = `"${schema}"."${table}"`;
  } else {
    tableRef = `"${index.table || ''}"`;
  }

  // Include schema in table reference for correct index creation
  return `CREATE ${unique}INDEX "${indexName}" ON ${tableRef} USING ${method} (${columns});`;
}

/**
 * Generate DROP INDEX SQL
 */
function generateDropIndexSQL(index: any): string {
  // Extract just the index name without schema
  const indexName = index.name
    ? index.name.includes('.')
      ? index.name.split('.')[1]
      : index.name
    : index;
  // Match Drizzle's format - no schema qualification
  return `DROP INDEX IF EXISTS "${indexName}";`;
}

/**
 * Generate CREATE FOREIGN KEY SQL (for existing tables)
 */
function generateCreateForeignKeySQL(fk: any): string {
  const schemaFrom = fk.schemaFrom || 'public';
  const schemaTo = fk.schemaTo || 'public';
  const tableFrom = fk.tableFrom;
  const columnsFrom = fk.columnsFrom.map((c: string) => `"${c}"`).join(', ');
  const columnsTo = fk.columnsTo.map((c: string) => `"${c}"`).join(', ');

  let sql = `ALTER TABLE "${schemaFrom}"."${tableFrom}" ADD CONSTRAINT "${fk.name}" FOREIGN KEY (${columnsFrom}) REFERENCES "${schemaTo}"."${fk.tableTo}" (${columnsTo})`;

  if (fk.onDelete) {
    sql += ` ON DELETE ${fk.onDelete}`;
  }

  if (fk.onUpdate) {
    sql += ` ON UPDATE ${fk.onUpdate}`;
  }

  return sql + ';';
}

/**
 * Generate DROP FOREIGN KEY SQL
 */
function generateDropForeignKeySQL(fk: any): string {
  const [schema, tableName] = fk.tableFrom
    ? fk.tableFrom.includes('.')
      ? fk.tableFrom.split('.')
      : ['public', fk.tableFrom]
    : ['public', ''];
  return `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT "${fk.name}";`;
}

/**
 * Generate SQL for renaming a table
 */
export function generateRenameTableSQL(oldName: string, newName: string): string {
  const [oldSchema, oldTable] = oldName.includes('.') ? oldName.split('.') : ['public', oldName];
  const [, newTable] = newName.includes('.') ? newName.split('.') : ['public', newName];
  return `ALTER TABLE "${oldSchema}"."${oldTable}" RENAME TO "${newTable}";`;
}

/**
 * Generate SQL for renaming a column
 */
export function generateRenameColumnSQL(table: string, oldName: string, newName: string): string {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  return `ALTER TABLE "${schema}"."${tableName}" RENAME COLUMN "${oldName}" TO "${newName}";`;
}

/**
 * Generate CREATE UNIQUE CONSTRAINT SQL
 */
function generateCreateUniqueConstraintSQL(constraint: any): string {
  const table = constraint.table || '';
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];

  const name = constraint.name;
  const columns = constraint.columns.map((c: string) => `"${c}"`).join(', ');

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
function generateDropUniqueConstraintSQL(constraint: any): string {
  const table = constraint.table || '';
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];

  return `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT "${constraint.name}";`;
}

/**
 * Generate CREATE CHECK CONSTRAINT SQL
 */
function generateCreateCheckConstraintSQL(constraint: any): string {
  const table = constraint.table || '';
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];

  const name = constraint.name;
  const value = constraint.value;

  return `ALTER TABLE "${schema}"."${tableName}" ADD CONSTRAINT "${name}" CHECK (${value});`;
}

/**
 * Generate DROP CHECK CONSTRAINT SQL
 */
function generateDropCheckConstraintSQL(constraint: any): string {
  const table = constraint.table || '';
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];

  return `ALTER TABLE "${schema}"."${tableName}" DROP CONSTRAINT "${constraint.name}";`;
}
