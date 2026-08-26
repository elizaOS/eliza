/**
 * Owns the runtime raw-SQL capability boundary shared by domain repositories:
 * lazy Drizzle query construction, database-adapter validation, and strict
 * extraction of supported driver row shapes.
 */
import { ElizaError } from "../errors.js";
import type { IAgentRuntime } from "../types/runtime.js";

export type RawSqlQuery = {
	queryChunks: Array<{ value?: unknown }>;
};

export type RuntimeRawSqlDb = {
	execute: (query: RawSqlQuery) => Promise<unknown>;
};

export interface RawSqlBoundaryOptions {
	subsystem: string;
	allowRuntimeDb?: boolean;
}

let cachedSqlRaw: ((query: string) => RawSqlQuery) | null = null;

export function asRawSqlRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export function coerceRawSqlText(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return fallback;
	return String(value);
}

export function coerceRawSqlNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export function coerceRawSqlBoolean(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(normalized)) return true;
		if (["0", "false", "no", "off"].includes(normalized)) return false;
	}
	return fallback;
}

function isMissingRawSqlJsonValue(value: unknown): boolean {
	return value === null || value === undefined || value === "";
}

export function parseRawSqlJsonValue<T>(
	value: unknown,
	fallback: T,
	options: RawSqlBoundaryOptions,
): T {
	if (isMissingRawSqlJsonValue(value)) return fallback;
	if (typeof value !== "string") {
		if (typeof value === "object") return value as T;
		throw new ElizaError(
			`[${options.subsystem}] Expected JSON string or object, received ${typeof value}.`,
			{
				code: "RAW_SQL_JSON_TYPE_INVALID",
				context: { subsystem: options.subsystem, valueType: typeof value },
			},
		);
	}
	try {
		return JSON.parse(value) as T;
	} catch (cause) {
		// error-policy:J2 Preserve the parser failure behind a domain-attributed database error.
		throw new ElizaError(
			`[${options.subsystem}] Invalid JSON value returned by the database.`,
			{
				code: "RAW_SQL_JSON_INVALID",
				context: { subsystem: options.subsystem },
				cause,
			},
		);
	}
}

export function parseRawSqlJsonRecord(
	value: unknown,
	options: RawSqlBoundaryOptions,
): Record<string, unknown> {
	if (isMissingRawSqlJsonValue(value)) return {};
	const parsed = parseRawSqlJsonValue<Record<string, unknown> | null>(
		value,
		null,
		options,
	);
	const object = asRawSqlRecord(parsed);
	if (object) return object;
	throw new ElizaError(
		`[${options.subsystem}] Expected JSON object from the database.`,
		{
			code: "RAW_SQL_JSON_OBJECT_INVALID",
			context: { subsystem: options.subsystem },
		},
	);
}

export function parseRawSqlJsonArray<T>(
	value: unknown,
	options: RawSqlBoundaryOptions,
): T[] {
	if (isMissingRawSqlJsonValue(value)) return [];
	const parsed = parseRawSqlJsonValue<T[] | null>(value, null, options);
	if (Array.isArray(parsed)) return parsed;
	throw new ElizaError(
		`[${options.subsystem}] Expected JSON array from the database.`,
		{
			code: "RAW_SQL_JSON_ARRAY_INVALID",
			context: { subsystem: options.subsystem },
		},
	);
}

/**
 * Accepts the two result envelopes returned by supported Drizzle drivers:
 * direct row arrays and objects with a `rows` array. Every row must be an
 * object; malformed envelopes reject instead of becoming a healthy empty set.
 */
export function extractRawSqlRows(
	result: unknown,
	options: RawSqlBoundaryOptions,
): Array<Record<string, unknown>> {
	const rows = Array.isArray(result) ? result : asRawSqlRecord(result)?.rows;
	if (!Array.isArray(rows)) {
		throw new ElizaError(
			`[${options.subsystem}] Database returned an unsupported raw-query result envelope.`,
			{
				code: "RAW_SQL_RESULT_SHAPE_INVALID",
				context: { subsystem: options.subsystem },
			},
		);
	}
	const normalized: Array<Record<string, unknown>> = [];
	for (const [index, row] of rows.entries()) {
		const object = asRawSqlRecord(row);
		if (!object) {
			throw new ElizaError(
				`[${options.subsystem}] Database returned a non-object raw-query row.`,
				{
					code: "RAW_SQL_ROW_SHAPE_INVALID",
					context: { subsystem: options.subsystem, rowIndex: index },
				},
			);
		}
		normalized.push(object);
	}
	return normalized;
}

export function findRuntimeRawSqlDb(
	runtime: IAgentRuntime,
	options: RawSqlBoundaryOptions,
): RuntimeRawSqlDb | null {
	const adapterDb = runtime.adapter?.db as RuntimeRawSqlDb | undefined;
	if (adapterDb && typeof adapterDb.execute === "function") return adapterDb;
	if (options.allowRuntimeDb) {
		const runtimeDb = (runtime as IAgentRuntime & { db?: RuntimeRawSqlDb }).db;
		if (runtimeDb && typeof runtimeDb.execute === "function") return runtimeDb;
	}
	return null;
}

export function getRuntimeRawSqlDb(
	runtime: IAgentRuntime,
	options: RawSqlBoundaryOptions,
): RuntimeRawSqlDb {
	const db = findRuntimeRawSqlDb(runtime, options);
	if (db) return db;
	throw new ElizaError(
		`[${options.subsystem}] runtime database adapter unavailable; load @elizaos/plugin-sql before durable operations.`,
		{
			code: "RAW_SQL_DATABASE_UNAVAILABLE",
			context: { subsystem: options.subsystem, agentId: runtime.agentId },
		},
	);
}

export async function executeRawSqlOnDb(
	db: RuntimeRawSqlDb,
	sqlText: string,
	options: RawSqlBoundaryOptions,
): Promise<Array<Record<string, unknown>>> {
	const raw = await getSqlRaw();
	const result = await db.execute(raw(sqlText));
	return extractRawSqlRows(result, options);
}

export async function executeRuntimeRawSql(
	runtime: IAgentRuntime,
	sqlText: string,
	options: RawSqlBoundaryOptions,
): Promise<Array<Record<string, unknown>>> {
	return executeRawSqlOnDb(
		getRuntimeRawSqlDb(runtime, options),
		sqlText,
		options,
	);
}

export function sqlQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function sqlText(value: string | null | undefined): string {
	if (value === null || value === undefined) return "NULL";
	return sqlQuote(value);
}

export function sqlBoolean(value: boolean): string {
	return value ? "TRUE" : "FALSE";
}

export function sqlInteger(value: number | null | undefined): string {
	if (value === null || value === undefined) return "NULL";
	if (!Number.isFinite(value)) {
		throw new ElizaError("invalid numeric SQL literal", {
			code: "RAW_SQL_INTEGER_LITERAL_INVALID",
			context: { value },
		});
	}
	return String(Math.trunc(value));
}

export function sqlNumber(value: number | null | undefined): string {
	if (value === null || value === undefined) return "NULL";
	if (!Number.isFinite(value)) {
		throw new ElizaError("invalid numeric SQL literal", {
			code: "RAW_SQL_NUMBER_LITERAL_INVALID",
			context: { value },
		});
	}
	return String(value);
}

export function sqlJson(value: unknown): string {
	return sqlQuote(JSON.stringify(value ?? null));
}

async function getSqlRaw(): Promise<(query: string) => RawSqlQuery> {
	if (cachedSqlRaw) return cachedSqlRaw;
	const drizzle = (await import("drizzle-orm")) as {
		sql: { raw: (query: string) => RawSqlQuery };
	};
	cachedSqlRaw = drizzle.sql.raw;
	return cachedSqlRaw;
}
