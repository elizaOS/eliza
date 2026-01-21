/**
 * JSON Storage Backend for @polyagent/db
 *
 * Provides a file-based storage implementation that mirrors the PostgreSQL interface.
 * Used for simulation, training data generation, and debugging.
 *
 * Usage:
 * ```typescript
 * import { initJsonStorage, db } from '@polyagent/db';
 *
 * // Initialize JSON mode
 * await initJsonStorage('./simulation-data');
 *
 * // Use db exactly like with PostgreSQL
 * const user = await db.user.create({ data: { ... } });
 * const posts = await db.post.findMany({ where: { authorId: user.id } });
 *
 * // Save snapshot
 * await saveJsonSnapshot();
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "./client";

// ============================================================================
// Types
// ============================================================================

type StorageMode = "postgres" | "json" | "memory";

interface JsonStorageState {
  metadata: {
    version: string;
    createdAt: string;
    updatedAt: string;
    mode: StorageMode;
  };
  tables: Record<string, Record<string, JsonRecord>>;
  counters: Record<string, number>;
}

type JsonRecord = Record<string, JsonValue | Date | undefined>;

interface FindOptions<T> {
  where?: WhereInput<T>;
  orderBy?: OrderByInput<T> | OrderByInput<T>[];
  take?: number;
  skip?: number;
  include?: Record<string, boolean>;
}

type WhereValue<T> =
  | T
  | {
      equals?: T;
      not?: T;
      in?: T[];
      notIn?: T[];
      lt?: T;
      lte?: T;
      gt?: T;
      gte?: T;
      contains?: string;
    }
  | null
  | undefined;

type WhereInput<T> = {
  [K in keyof T]?: WhereValue<T[K]>;
} & {
  AND?: WhereInput<T> | WhereInput<T>[];
  OR?: WhereInput<T>[];
  NOT?: WhereInput<T>;
};

type OrderByInput<T> = { [K in keyof T]?: "asc" | "desc" };

// ============================================================================
// State Management
// ============================================================================

let storageState: JsonStorageState | null = null;
let storagePath: string | null = null;
let autoSave = true;

function createEmptyState(): JsonStorageState {
  return {
    metadata: {
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mode: "json",
    },
    tables: {},
    counters: {},
  };
}

function getState(): JsonStorageState {
  if (!storageState) {
    storageState = createEmptyState();
  }
  return storageState;
}

function getTable(tableName: string): Record<string, JsonRecord> {
  const state = getState();
  if (!state.tables[tableName]) {
    state.tables[tableName] = {};
  }
  return state.tables[tableName];
}

function generateId(tableName: string): string {
  const state = getState();
  if (!state.counters[tableName]) {
    state.counters[tableName] = 0;
  }
  state.counters[tableName]++;
  const timestamp = Date.now();
  const counter = state.counters[tableName];
  return `json-${tableName}-${timestamp}-${counter}`;
}

// ============================================================================
// Query Matching
// ============================================================================

function matchesWhere<T extends JsonRecord>(
  record: T,
  where: WhereInput<T> | undefined,
): boolean {
  if (!where) return true;

  const toComparableNumber = (
    v: JsonValue | Date | undefined,
  ): number | null => {
    if (typeof v === "number") return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") {
      const parsed = Date.parse(v);
      return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
  };

  // Handle AND
  if (where.AND) {
    const andConditions = Array.isArray(where.AND) ? where.AND : [where.AND];
    if (!andConditions.every((w) => matchesWhere(record, w))) return false;
  }

  // Handle OR
  if (where.OR) {
    if (!where.OR.some((w) => matchesWhere(record, w))) return false;
  }

  // Handle NOT
  if (where.NOT) {
    if (matchesWhere(record, where.NOT)) return false;
  }

  // Handle field conditions
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND" || key === "OR" || key === "NOT") continue;

    const value = record[key];

    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }

    if (condition === undefined) continue;

    if (
      typeof condition === "object" &&
      condition !== null &&
      !Array.isArray(condition) &&
      !(condition instanceof Date)
    ) {
      const ops = condition as Record<string, JsonValue>;

      if ("equals" in ops) {
        if (value !== ops.equals) return false;
      }
      if ("not" in ops) {
        if (value === ops.not) return false;
      }
      if ("in" in ops && Array.isArray(ops.in)) {
        if (!ops.in.includes(value as JsonValue)) return false;
      }
      if ("notIn" in ops && Array.isArray(ops.notIn)) {
        if (ops.notIn.includes(value as JsonValue)) return false;
      }
      if ("lt" in ops) {
        const left = toComparableNumber(value as JsonValue | Date | undefined);
        const right = toComparableNumber(
          ops.lt as JsonValue | Date | undefined,
        );
        if (left === null || right === null || left >= right) return false;
      }
      if ("lte" in ops) {
        const left = toComparableNumber(value as JsonValue | Date | undefined);
        const right = toComparableNumber(
          ops.lte as JsonValue | Date | undefined,
        );
        if (left === null || right === null || left > right) return false;
      }
      if ("gt" in ops) {
        const left = toComparableNumber(value as JsonValue | Date | undefined);
        const right = toComparableNumber(
          ops.gt as JsonValue | Date | undefined,
        );
        if (left === null || right === null || left <= right) return false;
      }
      if ("gte" in ops) {
        const left = toComparableNumber(value as JsonValue | Date | undefined);
        const right = toComparableNumber(
          ops.gte as JsonValue | Date | undefined,
        );
        if (left === null || right === null || left < right) return false;
      }
      if ("contains" in ops && typeof ops.contains === "string") {
        if (typeof value !== "string" || !value.includes(ops.contains))
          return false;
      }
    } else {
      // Direct equality
      if (value !== condition) return false;
    }
  }

  return true;
}

function sortRecords<T extends JsonRecord>(
  records: T[],
  orderBy: OrderByInput<T> | OrderByInput<T>[] | undefined,
): T[] {
  if (!orderBy) return records;

  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];

  return [...records].sort((a, b) => {
    for (const order of orders) {
      for (const [key, direction] of Object.entries(order)) {
        const aVal = a[key];
        const bVal = b[key];

        if (aVal === bVal) continue;
        if (aVal === null || aVal === undefined)
          return direction === "asc" ? 1 : -1;
        if (bVal === null || bVal === undefined)
          return direction === "asc" ? -1 : 1;

        const comparison = aVal < bVal ? -1 : 1;
        return direction === "desc" ? -comparison : comparison;
      }
    }
    return 0;
  });
}

// ============================================================================
// JSON Table Repository
// ============================================================================

/**
 * JSON-backed table repository that mirrors the PostgreSQL TableRepository interface.
 */
export class JsonTableRepository<
  TSelect extends JsonRecord,
  TInsert extends JsonRecord,
> {
  constructor(
    private readonly tableName: string,
    private readonly idField: string = "id",
  ) {}

  async findUnique(options: FindOptions<TSelect>): Promise<TSelect | null> {
    const table = getTable(this.tableName);
    const records = Object.values(table) as TSelect[];
    const matching = records.filter((r) => matchesWhere(r, options.where));
    return matching[0] ?? null;
  }

  async findUniqueOrThrow(options: FindOptions<TSelect>): Promise<TSelect> {
    const result = await this.findUnique(options);
    if (!result) throw new Error(`Record not found in ${this.tableName}`);
    return result;
  }

  async findFirst(options: FindOptions<TSelect> = {}): Promise<TSelect | null> {
    const table = getTable(this.tableName);
    let records = Object.values(table) as TSelect[];
    records = records.filter((r) => matchesWhere(r, options.where));
    records = sortRecords(records, options.orderBy);
    if (options.skip) records = records.slice(options.skip);
    return records[0] ?? null;
  }

  async findFirstOrThrow(options: FindOptions<TSelect> = {}): Promise<TSelect> {
    const result = await this.findFirst(options);
    if (!result) throw new Error(`Record not found in ${this.tableName}`);
    return result;
  }

  async findMany(options: FindOptions<TSelect> = {}): Promise<TSelect[]> {
    const table = getTable(this.tableName);
    let records = Object.values(table) as TSelect[];
    records = records.filter((r) => matchesWhere(r, options.where));
    records = sortRecords(records, options.orderBy);
    if (options.skip) records = records.slice(options.skip);
    if (options.take) records = records.slice(0, options.take);
    return records;
  }

  async create(options: { data: TInsert }): Promise<TSelect> {
    const table = getTable(this.tableName);
    const data = { ...options.data } as JsonRecord;

    // Generate ID if not provided
    if (!data[this.idField]) {
      data[this.idField] = generateId(this.tableName);
    }

    // Set timestamps
    if (!data.createdAt) data.createdAt = new Date();
    if (!data.updatedAt) data.updatedAt = new Date();

    const id = String(data[this.idField]);
    table[id] = data;

    onStateChange();
    return data as TSelect;
  }

  async createMany(options: {
    data: TInsert[];
    skipDuplicates?: boolean;
  }): Promise<{ count: number }> {
    let count = 0;
    for (const item of options.data) {
      const id = item[this.idField as keyof TInsert];
      if (options.skipDuplicates && id) {
        const table = getTable(this.tableName);
        if (table[String(id)]) continue;
      }
      await this.create({ data: item });
      count++;
    }
    return { count };
  }

  async update(options: {
    where: WhereInput<TSelect>;
    data: Partial<TInsert>;
  }): Promise<TSelect> {
    const record = await this.findFirst({ where: options.where });
    if (!record) throw new Error(`Record not found in ${this.tableName}`);

    const table = getTable(this.tableName);
    const id = String(record[this.idField as keyof TSelect]);

    // Handle increment/decrement
    const updateData: JsonRecord = {};
    for (const [key, value] of Object.entries(options.data)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Date)
      ) {
        const ops = value as Record<string, number>;
        if ("increment" in ops) {
          const current = (record[key as keyof TSelect] as number) ?? 0;
          updateData[key] = current + ops.increment;
        } else if ("decrement" in ops) {
          const current = (record[key as keyof TSelect] as number) ?? 0;
          updateData[key] = current - ops.decrement;
        } else {
          updateData[key] = value as JsonValue;
        }
      } else {
        updateData[key] = value as JsonValue | Date;
      }
    }

    const updated = { ...record, ...updateData, updatedAt: new Date() };
    table[id] = updated as JsonRecord;

    onStateChange();
    return updated as TSelect;
  }

  async updateMany(options: {
    where: WhereInput<TSelect>;
    data: Partial<TInsert>;
  }): Promise<{ count: number }> {
    const records = await this.findMany({ where: options.where });
    for (const record of records) {
      await this.update({
        where: {
          [this.idField]: record[this.idField as keyof TSelect],
        } as WhereInput<TSelect>,
        data: options.data,
      });
    }
    return { count: records.length };
  }

  async delete(options: { where: WhereInput<TSelect> }): Promise<TSelect> {
    const record = await this.findFirst({ where: options.where });
    if (!record) throw new Error(`Record not found in ${this.tableName}`);

    const table = getTable(this.tableName);
    const id = String(record[this.idField as keyof TSelect]);
    delete table[id];

    onStateChange();
    return record;
  }

  async deleteMany(
    options: { where?: WhereInput<TSelect> } = {},
  ): Promise<{ count: number }> {
    const records = await this.findMany({ where: options.where });
    const table = getTable(this.tableName);

    for (const record of records) {
      const id = String(record[this.idField as keyof TSelect]);
      delete table[id];
    }

    onStateChange();
    return { count: records.length };
  }

  async upsert(options: {
    where: WhereInput<TSelect>;
    create: TInsert;
    update: Partial<TInsert>;
  }): Promise<TSelect> {
    const existing = await this.findFirst({ where: options.where });
    if (existing) {
      return this.update({ where: options.where, data: options.update });
    }
    return this.create({ data: options.create });
  }

  async count(options: { where?: WhereInput<TSelect> } = {}): Promise<number> {
    const records = await this.findMany({ where: options.where });
    return records.length;
  }

  async aggregate(options: {
    where?: WhereInput<TSelect>;
    _count?: boolean;
    _sum?: Record<string, boolean>;
    _avg?: Record<string, boolean>;
    _min?: Record<string, boolean>;
    _max?: Record<string, boolean>;
  }): Promise<Record<string, JsonValue>> {
    const records = await this.findMany({ where: options.where });
    const result: Record<string, JsonValue> = {};

    if (options._count) {
      result._count = { _all: records.length };
    }

    if (options._sum) {
      const sums: Record<string, number | null> = {};
      for (const key of Object.keys(options._sum)) {
        if (options._sum[key]) {
          sums[key] = records.reduce((sum, r) => {
            const val = r[key as keyof TSelect];
            return sum + (typeof val === "number" ? val : 0);
          }, 0);
        }
      }
      result._sum = sums;
    }

    if (options._avg) {
      const avgs: Record<string, number | null> = {};
      for (const key of Object.keys(options._avg)) {
        if (options._avg[key]) {
          const nums: number[] = [];
          for (const r of records) {
            const val = r[key as keyof TSelect];
            if (typeof val === "number") nums.push(val);
          }
          avgs[key] =
            nums.length > 0
              ? nums.reduce((a, b) => a + b, 0) / nums.length
              : null;
        }
      }
      result._avg = avgs;
    }

    return result;
  }

  async groupBy<TKey extends keyof TSelect>(options: {
    by: TKey[];
    where?: WhereInput<TSelect>;
    _count?: boolean;
  }): Promise<Array<Record<string, JsonValue>>> {
    const records = await this.findMany({ where: options.where });
    const groups = new Map<string, TSelect[]>();

    for (const record of records) {
      const key = options.by.map((k) => String(record[k])).join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)?.push(record);
    }

    return Array.from(groups.entries()).map(([, groupRecords]) => {
      const result: Record<string, JsonValue> = {};
      const first = groupRecords[0]!;

      for (const key of options.by) {
        result[key as string] = first[key] as JsonValue;
      }

      if (options._count) {
        result._count = groupRecords.length;
      }

      return result;
    });
  }
}

// ============================================================================
// State Change Handler
// ============================================================================

function onStateChange(): void {
  if (autoSave && storagePath) {
    void saveJsonSnapshot();
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Initialize JSON storage mode */
export async function initJsonStorage(
  basePath: string,
  options: { autoSave?: boolean } = {},
): Promise<void> {
  storagePath = basePath;
  autoSave = options.autoSave ?? true;

  // Ensure directory exists
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }

  // Load existing state if available
  const statePath = join(basePath, "state.json");
  if (existsSync(statePath)) {
    const data = readFileSync(statePath, "utf-8");
    storageState = JSON.parse(data) as JsonStorageState;
  } else {
    storageState = createEmptyState();
  }
}

/** Save current state to JSON file */
export async function saveJsonSnapshot(): Promise<void> {
  if (!storagePath || !storageState) return;

  const statePath = join(storagePath, "state.json");
  storageState.metadata.updatedAt = new Date().toISOString();
  writeFileSync(statePath, JSON.stringify(storageState, null, 2));
}

/** Load state from JSON file */
export async function loadJsonSnapshot(path: string): Promise<void> {
  const data = readFileSync(path, "utf-8");
  storageState = JSON.parse(data) as JsonStorageState;
}

/** Export state to a specific JSON file */
export async function exportJsonState(path: string): Promise<void> {
  if (!storageState) return;
  storageState.metadata.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(storageState, null, 2));
}

/** Check if running in JSON mode */
export function isJsonMode(): boolean {
  return storageState !== null;
}

/** Get the current JSON storage base path (JSON/memory mode only). */
export function getJsonStoragePath(): string | null {
  return storagePath;
}

/** Clear JSON storage state (for testing) */
export function clearJsonStorage(): void {
  storageState = createEmptyState();
  storagePath = null;
}

/** Get raw state access (for debugging) */
export function getJsonState(): JsonStorageState | null {
  return storageState;
}
