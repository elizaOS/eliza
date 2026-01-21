/**
 * Common Type Definitions
 *
 * Shared types for common patterns that replace 'unknown' and 'any'
 */

import { z } from "zod";

/**
 * JSON-serializable value types
 * Note: undefined is NOT included as it's not valid JSON - use optional properties instead
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Zod schema for JSON-serializable values
 * Used in validation schemas for metadata and flexible data fields
 */
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
 * Error-like object that may have a message property
 */
export interface ErrorLike {
  message?: string;
  name?: string;
  stack?: string;
  code?: string | number;
  [key: string]: JsonValue | undefined;
}

/**
 * Parameters for JSON-RPC requests
 */
export type JsonRpcParams = StringRecord<JsonValue> | JsonValue[];

/**
 * Result type for JSON-RPC responses
 */
export type JsonRpcResult = JsonValue | StringRecord<JsonValue> | JsonValue[];

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
 * Query parameters combining pagination, sorting, and filtering
 */
export interface QueryParams extends PaginationParams {
  sort?: SortParams;
  filters?: FilterParams;
}

/**
 * PostHog Server Client Interface
 * Minimal interface for PostHog Node.js client (optional peer dependency)
 */
export interface PostHogServerClient {
  capture(params: {
    distinctId: string;
    event: string;
    properties?: StringRecord<JsonValue>;
  }): void;
  identify(params: {
    distinctId: string;
    properties?: StringRecord<JsonValue>;
  }): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * PostHog Server Client Constructor
 * Type for PostHog constructor from posthog-node package
 */
export interface PostHogServerConstructor {
  new (
    apiKey: string,
    options?: {
      host?: string;
      flushAt?: number;
      flushInterval?: number;
      requestTimeout?: number;
    },
  ): PostHogServerClient;
}

/**
 * PostHog Client Interface (browser)
 * Minimal interface for PostHog JS client (optional peer dependency)
 */
export interface PostHogClient {
  init(
    apiKey: string,
    options?: {
      api_host?: string;
      capture_pageview?: boolean;
      capture_pageleave?: boolean;
      session_recording?: {
        maskAllInputs?: boolean;
        maskTextSelector?: string;
        recordCrossOriginIframes?: boolean;
      };
      autocapture?: {
        dom_event_allowlist?: string[];
        url_allowlist?: string[];
        element_allowlist?: string[];
        css_selector_allowlist?: string[];
      };
      loaded?: () => void;
      respect_dnt?: boolean;
      persistence?: string;
      enable_recording_console_log?: boolean;
      capture_exceptions?: boolean;
      sanitize_properties?: (
        properties: StringRecord<JsonValue>,
      ) => StringRecord<JsonValue>;
    },
  ): void;
  capture(event: string, properties?: StringRecord<JsonValue>): void;
  identify(distinctId: string, properties?: StringRecord<JsonValue>): void;
  reset(): void;
  __loaded?: boolean;
}

/**
 * PostHog Client Constructor (browser)
 * Type for PostHog default export from posthog-js package
 */
export interface PostHogClientConstructor {
  (): PostHogClient;
  default: PostHogClientConstructor;
}
