import type { SchemaSnapshot } from '../types';
import type { SchemaDiff } from './diff-calculator';

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

  // Phase 1: Generate CREATE TABLE statements for new tables (WITHOUT foreign keys)
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

  // Add all CREATE TABLE statements first
  statements.push(...createTableStatements);

  // Phase 2: Add all foreign keys AFTER tables are created
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

  // Phase 3: Handle table modifications

  // Generate DROP TABLE statements for deleted tables
  for (const tableName of diff.tables.deleted) {
    const [schema, name] = tableName.includes('.') ? tableName.split('.') : ['public', tableName];
    statements.push(`DROP TABLE IF EXISTS "${schema}"."${name}" CASCADE;`);
  }

  // Generate ALTER TABLE statements for column changes
  for (const added of diff.columns.added) {
    statements.push(generateAddColumnSQL(added.table, added.column, added.definition));
  }

  for (const deleted of diff.columns.deleted) {
    statements.push(generateDropColumnSQL(deleted.table, deleted.column));
  }

  for (const modified of diff.columns.modified) {
    statements.push(...generateAlterColumnSQL(modified.table, modified.column, modified.changes));
  }

  // Generate CREATE INDEX statements
  for (const index of diff.indexes.created) {
    statements.push(generateCreateIndexSQL(index));
  }

  // Generate DROP INDEX statements
  for (const index of diff.indexes.deleted) {
    statements.push(generateDropIndexSQL(index));
  }

  // Handle foreign key modifications (for existing tables)
  for (const fk of diff.foreignKeys.created) {
    // Only add if it's not part of a new table (those were handled above)
    // Check both with and without schema prefix
    const tableFrom = fk.tableFrom || '';
    const isNewTable = diff.tables.created.some((tableName) => {
      // Compare table names, handling schema prefixes
      const [createdSchema, createdTable] = tableName.includes('.')
        ? tableName.split('.')
        : ['public', tableName];
      const [fkSchema, fkTable] = tableFrom.includes('.')
        ? tableFrom.split('.')
        : ['public', tableFrom];
      return createdTable === fkTable && createdSchema === fkSchema;
    });

    if (!isNewTable) {
      statements.push(generateCreateForeignKeySQL(fk));
    }
  }

  for (const fk of diff.foreignKeys.deleted) {
    statements.push(generateDropForeignKeySQL(fk));
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

  let tableSQL = '';

  // Create schema if not public
  if (schema !== 'public') {
    tableSQL += `CREATE SCHEMA IF NOT EXISTS "${schema}";\n`;
  }

  tableSQL += `CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (\n  ${columns.join(',\n  ')}\n);`;

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

  // Add DEFAULT value
  if (def.default !== undefined) {
    sql += ` DEFAULT ${def.default}`;
  }

  return sql;
}

/**
 * Generate ADD COLUMN SQL
 */
function generateAddColumnSQL(table: string, column: string, definition: any): string {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  const colDef = generateColumnDefinition(column, definition);
  return `ALTER TABLE "${schema}"."${tableName}" ADD COLUMN ${colDef};`;
}

/**
 * Generate DROP COLUMN SQL
 */
function generateDropColumnSQL(table: string, column: string): string {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  return `ALTER TABLE "${schema}"."${tableName}" DROP COLUMN "${column}";`;
}

/**
 * Generate ALTER COLUMN SQL
 */
function generateAlterColumnSQL(table: string, column: string, changes: any): string[] {
  const [schema, tableName] = table.includes('.') ? table.split('.') : ['public', table];
  const statements: string[] = [];

  // Handle type changes
  if (changes.to?.type !== changes.from?.type) {
    const newType = changes.to?.type || 'TEXT';
    statements.push(
      `ALTER TABLE "${schema}"."${tableName}" ALTER COLUMN "${column}" TYPE ${newType};`
    );
  }

  // Handle NOT NULL changes
  if (changes.to?.notNull !== changes.from?.notNull) {
    if (changes.to?.notNull) {
      statements.push(
        `ALTER TABLE "${schema}"."${tableName}" ALTER COLUMN "${column}" SET NOT NULL;`
      );
    } else {
      statements.push(
        `ALTER TABLE "${schema}"."${tableName}" ALTER COLUMN "${column}" DROP NOT NULL;`
      );
    }
  }

  // Handle DEFAULT changes
  if (changes.to?.default !== changes.from?.default) {
    if (changes.to?.default !== undefined) {
      statements.push(
        `ALTER TABLE "${schema}"."${tableName}" ALTER COLUMN "${column}" SET DEFAULT ${changes.to.default};`
      );
    } else {
      statements.push(
        `ALTER TABLE "${schema}"."${tableName}" ALTER COLUMN "${column}" DROP DEFAULT;`
      );
    }
  }

  return statements;
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
      return `"${c.expression}"${c.asc === false ? ' DESC' : ''}${c.nulls ? ' NULLS ' + c.nulls.toUpperCase() : ''}`;
    })
    .join(', ');

  const [schema, indexName] = index.name.includes('.')
    ? index.name.split('.')
    : ['public', index.name];
  const [tableSchema, tableName] = index.table
    ? index.table.includes('.')
      ? index.table.split('.')
      : ['public', index.table]
    : [schema, ''];

  return `CREATE ${unique}INDEX "${indexName}" ON "${tableSchema}"."${tableName}" USING ${method} (${columns});`;
}

/**
 * Generate DROP INDEX SQL
 */
function generateDropIndexSQL(index: any): string {
  const [schema, indexName] = index.name
    ? index.name.includes('.')
      ? index.name.split('.')
      : ['public', index.name]
    : ['public', index];
  return `DROP INDEX IF EXISTS "${schema}"."${indexName}";`;
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
