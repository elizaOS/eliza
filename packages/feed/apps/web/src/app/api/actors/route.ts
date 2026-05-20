/**
 * Actors Data API
 *
 * @route GET /api/actors
 * @access Public
 *
 * @description
 * Returns all actors and organizations data from the game world. Uses TypeScript
 * imports for optimal performance and type safety. Includes NPCs, organizations,
 * and their metadata.
 *
 * @openapi
 * /api/actors:
 *   get:
 *     tags:
 *       - Actors
 *     summary: Get all actors and organizations
 *     description: Returns complete list of all actors (NPCs) and organizations in the game world with their metadata, roles, and relationships.
 *     responses:
 *       200:
 *         description: Actors data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 actors:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       role:
 *                         type: string
 *                       tier:
 *                         type: string
 *                       description:
 *                         type: string
 *                 organizations:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: Failed to load actors data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *
 * @returns {Promise<NextResponse>} JSON response with actors and organizations data
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/actors');
 * const data = await response.json();
 * console.log(data.actors); // Array of all actors
 * ```
 *
 * @see {@link @feed/engine#loadActorsData} Actors data loader (TypeScript imports)
 */

import { withErrorHandling } from "@feed/api";
import { loadActorsData } from "@feed/engine";
import { NextResponse } from "next/server";

/**
 * GET /api/actors
 *
 * @description Fetches all actors and organizations data from the game world
 *
 * @returns {Promise<NextResponse>} Actors and organizations data
 */
export const GET = withErrorHandling(async function GET() {
  const actorsData = loadActorsData();
  return NextResponse.json(actorsData);
});
