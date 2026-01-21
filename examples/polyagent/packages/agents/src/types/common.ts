/**
 * Common Type Definitions for @polyagent/agents
 *
 * Shared types for common patterns
 */

import { z } from "zod";

/**
 * JSON-serializable value types
 * Note: undefined is intentionally excluded as it's not valid JSON
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonValueSchema = z.ZodType<JsonValue>;

export const JsonValueSchema: JsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Generic key-value record with string keys
 */
export type StringRecord<T = JsonValue> = Record<string, T>;

/**
 * Log data payload
 */
export type LogData =
  | JsonValue
  | StringRecord
  | Error
  | { [key: string]: JsonValue | unknown }
  | unknown;

/**
 * Error-like object
 */
export interface ErrorLike {
  message?: string;
  name?: string;
  stack?: string;
  code?: string | number;
  [key: string]: JsonValue | undefined;
}

/**
 * JSON-RPC params
 */
export type JsonRpcParams = StringRecord<JsonValue> | JsonValue[];

/**
 * JSON-RPC result
 */
export type JsonRpcResult = JsonValue | StringRecord<JsonValue> | JsonValue[];

/**
 * LLM response wrapper
 */
export interface LLMResponse<T = JsonValue> {
  content: string;
  parsed?: T;
  raw?: string;
  metadata?: {
    model?: string;
    tokens?: number;
    temperature?: number;
  };
}

/**
 * API response wrapper
 */
export interface ApiResponse<T = JsonValue> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  limit: number;
  offset: number;
  page?: number;
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * Sort order
 */
export type SortOrder = "asc" | "desc";

/**
 * Sort parameters
 */
export interface SortParams {
  field: string;
  order: SortOrder;
}

/**
 * Filter parameters
 */
export interface FilterParams {
  [key: string]: JsonValue | JsonValue[] | undefined;
}

/**
 * Query parameters
 */
export interface QueryParams extends PaginationParams {
  sort?: SortParams;
  filters?: FilterParams;
}
