/**
 * OpenAPI Specification API Route
 *
 * @description Serves the automatically generated OpenAPI specification in JSON format
 *
 * @route GET /api/docs
 * @access Public
 * @returns {object} OpenAPI 3.0 specification
 *
 * @openapi
 * /api/docs:
 *   get:
 *     tags:
 *       - Documentation
 *     summary: Get OpenAPI specification
 *     description: Returns the complete OpenAPI specification for all API routes. Automatically generated from @openapi tags in route files. Cached for 1 hour.
 *     responses:
 *       200:
 *         description: OpenAPI specification
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 openapi:
 *                   type: string
 *                   example: "3.0.0"
 *                 info:
 *                   type: object
 *                 paths:
 *                   type: object
 *       500:
 *         description: Failed to generate documentation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */

import { generateAutoSpec, withErrorHandling } from '@feed/api';
import { NextResponse } from 'next/server';

/**
 * GET /api/docs
 *
 * @description Returns the complete OpenAPI specification for all API routes.
 * Automatically generated from @openapi tags in route files.
 *
 * @returns {NextResponse} OpenAPI specification in JSON format
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/docs');
 * const spec = await response.json();
 * console.log(spec.paths); // All API paths
 * ```
 */
export const GET = withErrorHandling(async function GET() {
  const spec = (await generateAutoSpec()) as {
    openapi?: string;
    swagger?: string;
    [key: string]: unknown;
  };

  // Ensure openapi version field is present (required by Swagger UI)
  if (!spec.openapi && !spec.swagger) {
    spec.openapi = '3.0.0';
  }

  return NextResponse.json(spec, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
});
