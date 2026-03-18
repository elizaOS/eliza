/**
 * In-memory plugin store implementation
 *
 * WHY: Plugins that need custom tables (goals, todos) use runtime.getPluginStore().
 * SQL adapters use SqlPluginStore; in-memory and file-backed adapters use this
 * implementation with a pluggable backend (Map or IStorage).
 */

import type {
  IPluginStore,
  PluginFilter,
  PluginFilterValue,
  PluginOrderBy,
  PluginQueryOptions,
  PluginSchema,
  UUID,
} from "../types";

/**
 * Backend for plugin store row storage. Allows in-memory (Map) or persisted (IStorage) implementations.
 */
export interface IPluginStoreBackend {
  getAll(tableKey: string): Promise<Record<string, unknown>[]>;
  get(tableKey: string, id: string): Promise<Record<string, unknown> | null>;
  set(tableKey: string, id: string, row: Record<string, unknown>): Promise<void>;
  delete(tableKey: string, id: string): Promise<void>;
  deleteWhere(
    tableKey: string,
    predicate: (row: Record<string, unknown>) => boolean,
  ): Promise<void>;
  count(
    tableKey: string,
    predicate?: (row: Record<string, unknown>) => boolean,
  ): Promise<number>;
}

function matchesFilter(row: Record<string, unknown>, filter: PluginFilter): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const rowVal = row[key];
    if (value === null) {
      if (rowVal !== null && rowVal !== undefined) return false;
      continue;
    }
    if (typeof value === "object" && value !== null) {
      if ("$in" in value && Array.isArray(value.$in)) {
        if (!value.$in.includes(rowVal as string | number | boolean)) return false;
      } else if ("$gt" in value) {
        const v: number | Date = value.$gt;
        if (rowVal instanceof Date && v instanceof Date) {
          if (rowVal <= v) return false;
        } else if (typeof rowVal === "number" && typeof v === "number") {
          if (rowVal <= v) return false;
        } else return false;
      } else if ("$gte" in value) {
        const v: number | Date = value.$gte;
        if (rowVal instanceof Date && v instanceof Date) {
          if (rowVal < v) return false;
        } else if (typeof rowVal === "number" && typeof v === "number") {
          if (rowVal < v) return false;
        } else return false;
      } else if ("$lt" in value) {
        const v: number | Date = value.$lt;
        if (rowVal instanceof Date && v instanceof Date) {
          if (rowVal >= v) return false;
        } else if (typeof rowVal === "number" && typeof v === "number") {
          if (rowVal >= v) return false;
        } else return false;
      } else if ("$lte" in value) {
        const v: number | Date = value.$lte;
        if (rowVal instanceof Date && v instanceof Date) {
          if (rowVal > v) return false;
        } else if (typeof rowVal === "number" && typeof v === "number") {
          if (rowVal > v) return false;
        } else return false;
      }
    } else {
      if (rowVal !== value) return false;
    }
  }
  return true;
}

function compare(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  orderBy: PluginOrderBy[],
): number {
  for (const o of orderBy) {
    const aVal = a[o.column];
    const bVal = b[o.column];
    let cmp = 0;
    if (aVal === bVal) continue;
    if (aVal == null && bVal != null) cmp = -1;
    else if (aVal != null && bVal == null) cmp = 1;
    else if (typeof aVal === "number" && typeof bVal === "number") cmp = aVal - bVal;
    else if (aVal instanceof Date && bVal instanceof Date)
      cmp = aVal.getTime() - bVal.getTime();
    else cmp = String(aVal).localeCompare(String(bVal));
    if (o.direction === "desc") cmp = -cmp;
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function genId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `plg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * In-memory plugin store. Uses a backend for actual row storage (Map or IStorage).
 */
export class InMemoryPluginStore implements IPluginStore {
  constructor(
    private pluginName: string,
    private backend: IPluginStoreBackend,
  ) {}

  private tableKey(table: string): string {
    return `${this.pluginName}_${table}`;
  }

  async query<T = Record<string, unknown>>(
    table: string,
    filter?: PluginFilter,
    options?: PluginQueryOptions,
  ): Promise<T[]> {
    const key = this.tableKey(table);
    let rows = await this.backend.getAll(key);
    if (filter && Object.keys(filter).length > 0) {
      rows = rows.filter((r) => matchesFilter(r, filter));
    }
    const orderBy = options?.orderBy
      ? Array.isArray(options.orderBy)
        ? options.orderBy
        : [options.orderBy]
      : [];
    if (orderBy.length > 0) {
      rows = [...rows].sort((a, b) => compare(a, b, orderBy));
    }
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? rows.length;
    rows = rows.slice(offset, offset + limit);
    return rows as T[];
  }

  async getById<T = Record<string, unknown>>(
    table: string,
    id: UUID,
  ): Promise<T | null> {
    const key = this.tableKey(table);
    const row = await this.backend.get(key, id as string);
    return (row as T) ?? null;
  }

  async insert(
    table: string,
    rows: Record<string, unknown>[],
  ): Promise<UUID[]> {
    if (rows.length === 0) return [];
    const key = this.tableKey(table);
    const ids: UUID[] = [];
    for (const row of rows) {
      const id = (row.id as string) ?? genId();
      const full = { ...row, id };
      await this.backend.set(key, id, full);
      ids.push(id as UUID);
    }
    return ids;
  }

  async update(
    table: string,
    filter: PluginFilter,
    set: Record<string, unknown>,
  ): Promise<number> {
    if (Object.keys(filter).length === 0) {
      throw new Error("Update requires a filter (safety check)");
    }
    const key = this.tableKey(table);
    const rows = await this.backend.getAll(key);
    const toUpdate = rows.filter((r) => matchesFilter(r, filter));
    let n = 0;
    for (const row of toUpdate) {
      const id = row.id as string;
      if (!id) continue;
      const updated = { ...row, ...set, id };
      await this.backend.set(key, id, updated);
      n++;
    }
    return n;
  }

  async delete(table: string, filter: PluginFilter): Promise<number> {
    if (Object.keys(filter).length === 0) {
      throw new Error("Delete requires a filter (safety check)");
    }
    const key = this.tableKey(table);
    const rows = await this.backend.getAll(key);
    const toDelete = rows.filter((r) => matchesFilter(r, filter));
    for (const row of toDelete) {
      const id = row.id as string;
      if (id) await this.backend.delete(key, id);
    }
    return toDelete.length;
  }

  async count(table: string, filter?: PluginFilter): Promise<number> {
    const key = this.tableKey(table);
    if (!filter || Object.keys(filter).length === 0) {
      return this.backend.count(key);
    }
    const predicate = (row: Record<string, unknown>) => matchesFilter(row, filter);
    return this.backend.count(key, predicate);
  }
}

/**
 * Create a backend that stores plugin table data in memory (Map).
 * Use for core InMemoryDatabaseAdapter and plugin-inmemorydb.
 */
export function createMapBackend(): {
  backend: IPluginStoreBackend;
  data: Map<string, Map<string, Record<string, unknown>>>;
} {
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  function getTable(tableKey: string): Map<string, Record<string, unknown>> {
    let t = data.get(tableKey);
    if (!t) {
      t = new Map();
      data.set(tableKey, t);
    }
    return t;
  }
  const backend: IPluginStoreBackend = {
    async getAll(tableKey: string) {
      return Array.from(getTable(tableKey).values());
    },
    async get(tableKey: string, id: string) {
      return getTable(tableKey).get(id) ?? null;
    },
    async set(tableKey: string, id: string, row: Record<string, unknown>) {
      getTable(tableKey).set(id, row);
    },
    async delete(tableKey: string, id: string) {
      getTable(tableKey).delete(id);
    },
    async deleteWhere(
      tableKey: string,
      predicate: (row: Record<string, unknown>) => boolean,
    ) {
      const t = getTable(tableKey);
      for (const [id, row] of t.entries()) {
        if (predicate(row)) t.delete(id);
      }
    },
    async count(
      tableKey: string,
      predicate?: (row: Record<string, unknown>) => boolean,
    ) {
      const rows = Array.from(getTable(tableKey).values());
      if (!predicate) return rows.length;
      return rows.filter(predicate).length;
    },
  };
  return { backend, data };
}
