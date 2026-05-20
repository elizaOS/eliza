/**
 * Automated OpenAPI Specification Generator
 *
 * @module lib/swagger/auto-generator
 * @description Returns the canonical Feed OpenAPI spec used by the docs route.
 */

import { swaggerDefinition } from './config';
import { generateOpenApiSpec } from './generator';

/**
 * OpenAPI specification type.
 */
interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info?: Record<string, unknown>;
  components?: Record<string, unknown>;
  paths?: Record<string, unknown>;
  tags?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Generate the Feed OpenAPI specification.
 *
 * The manual generator is the stable source of truth here. It already includes
 * the documented routes, tags, and security schemes used by the docs UI and
 * integration tests, without depending on runtime parsing.
 */
export async function generateAutoSpec(): Promise<OpenAPISpec> {
  const manualSpec = generateOpenApiSpec();

  return {
    ...swaggerDefinition,
    ...manualSpec,
    components: swaggerDefinition.components,
  };
}
