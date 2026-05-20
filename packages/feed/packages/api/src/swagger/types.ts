/**
 * OpenAPI Type Definitions
 *
 * Type definitions for OpenAPI/Swagger documentation.
 *
 * @module lib/swagger/types
 */

/**
 * OpenAPI route documentation
 *
 * @description Used to document API routes in a type-safe way
 */
export interface OpenAPIRoute {
  /** Route path (e.g., '/api/users/me') */
  path: string;
  /** HTTP method(s) supported */
  methods: ("GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  /** Route summary (short description) */
  summary: string;
  /** Detailed description */
  description: string;
  /** Tags for grouping in Swagger UI */
  tags: string[];
  /** Whether authentication is required */
  requiresAuth: boolean;
  /** Query parameters */
  parameters?: OpenAPIParameter[];
  /** Request body schema */
  requestBody?: {
    required: boolean;
    content: Record<string, { schema: object }>;
  };
  /** Response schemas */
  responses: Record<number, OpenAPIResponse>;
}

/**
 * OpenAPI parameter definition
 */
export interface OpenAPIParameter {
  /** Parameter name */
  name: string;
  /** Where the parameter is located */
  in: "query" | "path" | "header" | "cookie";
  /** Parameter description */
  description: string;
  /** Whether parameter is required */
  required: boolean;
  /** Parameter schema */
  schema: {
    type: string;
    format?: string;
    enum?: string[];
    default?: unknown;
  };
}

/**
 * OpenAPI response definition
 */
export interface OpenAPIResponse {
  /** Response description */
  description: string;
  /** Response content types */
  content?: Record<string, { schema: object; example?: unknown }>;
}
