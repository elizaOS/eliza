/**
 * Organizations API
 *
 * @route GET /api/organizations - Get organizations
 * @access Public
 *
 * @description
 * Returns list of organizations in the game world. Supports filtering by IDs
 * for batch lookups. Organizations represent groups, factions, and institutions
 * in the Feed game world.
 *
 * @openapi
 * /api/organizations:
 *   get:
 *     tags:
 *       - Organizations
 *     summary: Get organizations
 *     description: Returns list of organizations, optionally filtered by IDs
 *     parameters:
 *       - in: query
 *         name: ids
 *         schema:
 *           type: string
 *         description: Comma-separated organization IDs for batch lookup
 *         example: org1,org2,org3
 *     responses:
 *       200:
 *         description: Organizations retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 organizations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                       description:
 *                         type: string
 *
 * @example
 * ```typescript
 * // Get all organizations
 * const response = await fetch('/api/organizations');
 * const { organizations } = await response.json();
 *
 * // Get specific organizations
 * const batch = await fetch('/api/organizations?ids=org1,org2');
 * ```
 *
 * @see {@link /lib/db/context} RLS context
 */

import {
  addPublicReadHeaders,
  publicRateLimit,
  withErrorHandling,
} from '@feed/api';
import { StaticDataRegistry } from '@feed/engine';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

/**
 * GET /api/organizations
 *
 * @description Get organizations, optionally filtered by IDs
 *
 * @param {NextRequest} request - Request object
 *
 * @returns {Promise<NextResponse>} Organizations data
 */
export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const { error, rateLimitInfo } = await publicRateLimit(request);
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get('ids');

  const allOrgs = StaticDataRegistry.getAllOrganizations();

  const organizations = idsParam
    ? allOrgs
        .filter((org) => idsParam.split(',').includes(org.id))
        .map((org) => ({
          id: org.id,
          name: org.name,
          type: org.type,
          description: org.description ?? null,
        }))
    : allOrgs.slice(0, 100).map((org) => ({
        id: org.id,
        name: org.name,
        type: org.type,
        description: org.description ?? null,
      }));

  const res = NextResponse.json({
    success: true,
    organizations,
  });
  if (rateLimitInfo) addPublicReadHeaders(res, rateLimitInfo);
  return res;
});
