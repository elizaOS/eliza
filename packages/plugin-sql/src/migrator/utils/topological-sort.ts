import { logger } from '@elizaos/core';
import type { TableDefinition } from '../types';

/**
 * Topological sort for dependency ordering
 * Ensures tables are created in the correct order based on their foreign key dependencies
 */
export function topologicalSort(tables: Map<string, TableDefinition>): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(tableName: string) {
    if (visiting.has(tableName)) {
      logger.warn(`Circular dependency detected involving table: ${tableName}`);
      return;
    }

    if (visited.has(tableName)) {
      return;
    }

    visiting.add(tableName);

    const table = tables.get(tableName);
    if (table) {
      // Visit dependencies first
      for (const dep of table.dependencies) {
        if (tables.has(dep)) {
          visit(dep);
        }
      }
    }

    visiting.delete(tableName);
    visited.add(tableName);
    sorted.push(tableName);
  }

  // Visit all tables
  for (const tableName of tables.keys()) {
    visit(tableName);
  }

  return sorted;
}
