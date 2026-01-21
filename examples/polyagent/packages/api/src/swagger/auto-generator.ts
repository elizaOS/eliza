/**
 * Automated OpenAPI Specification Generator
 *
 * @module lib/swagger/auto-generator
 * @description Automatically generates OpenAPI spec from @openapi tags in route files
 */

/// <reference path="./swagger-jsdoc.d.ts" />

import path from "node:path";
import { swaggerDefinition } from "./config";
import { generateOpenApiSpec } from "./generator";

// swagger-jsdoc is an optional dev dependency for docs generation
// Use dynamic import to handle cases where it's not installed
type SwaggerJsdocOptions = {
  definition: Record<string, unknown>;
  apis: string[];
};

type SwaggerJsdocFunction = (
  options: SwaggerJsdocOptions,
) => Record<string, unknown>;

/**
 * OpenAPI specification type
 */
interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Generate OpenAPI specification automatically from JSDoc comments
 *
 * @description Scans all API route files for @openapi tags and generates
 * a complete OpenAPI 3.0 specification. This eliminates the need for manual
 * spec maintenance.
 *
 * @returns {object} Complete OpenAPI 3.0 specification
 *
 * @example
 * ```typescript
 * import { generateAutoSpec } from '@polyagent/api';
 *
 * const spec = generateAutoSpec();
 * console.log(spec.paths); // All documented paths
 * ```
 */
export async function generateAutoSpec() {
  // Dynamically import swagger-jsdoc if available (optional dev dependency)
  let swaggerJsdoc: SwaggerJsdocFunction | null = null;
  const swaggerModule = await import("swagger-jsdoc");
  // Handle type mismatch between swagger-jsdoc types and our interface
  swaggerJsdoc = swaggerModule.default as unknown as SwaggerJsdocFunction;

  // Check if we're in a Node.js environment with file system access
  if (typeof process === "undefined" || typeof process.cwd !== "function") {
    // Edge runtime environment - return minimal spec without file scanning
    return {
      openapi: swaggerDefinition.openapi || "3.0.0",
      info: swaggerDefinition.info,
      paths: {},
      tags: [],
    };
  }

  const options: SwaggerJsdocOptions = {
    definition: swaggerDefinition,
    // Scan all route files for @openapi JSDoc comments using absolute paths
    apis: [
      path.join(process.cwd(), "src/app/api/**/*.ts"),
      path.join(process.cwd(), "src/app/api/**/*.tsx"),
    ],
  };

  // Generate auto spec if swagger-jsdoc is available, otherwise use base spec
  const autoSpec: OpenAPISpec = swaggerJsdoc
    ? (swaggerJsdoc(options) as OpenAPISpec)
    : {
        openapi: swaggerDefinition.openapi || "3.0.0",
        info: swaggerDefinition.info,
      };

  // Ensure openapi version field is present (required by Swagger UI)
  if (!autoSpec.openapi && !autoSpec.swagger) {
    autoSpec.openapi = swaggerDefinition.openapi || "3.0.0";
  }

  // Ensure all required OpenAPI fields are present
  if (!autoSpec.info) {
    autoSpec.info = swaggerDefinition.info;
  }

  // Merge with manual generator to ensure complete documentation coverage
  const manualSpec = generateOpenApiSpec();

  // Merge paths: auto-generated takes precedence, manual spec fills gaps
  const combinedSpec: OpenAPISpec = {
    ...swaggerDefinition,
    ...autoSpec,
    paths: {
      ...(manualSpec.paths || {}),
      ...(autoSpec.paths || {}),
    },
    tags: [
      ...(Array.isArray(manualSpec.tags) ? manualSpec.tags : []),
      ...(Array.isArray(autoSpec.tags) ? autoSpec.tags : []),
    ],
  };

  // Remove duplicate tags
  const uniqueTags = new Map();
  if (Array.isArray(combinedSpec.tags)) {
    combinedSpec.tags.forEach((tag: { name: string; description?: string }) => {
      if (!uniqueTags.has(tag.name)) {
        uniqueTags.set(tag.name, tag);
      }
    });
    combinedSpec.tags = Array.from(uniqueTags.values());
  }

  return combinedSpec;
}
