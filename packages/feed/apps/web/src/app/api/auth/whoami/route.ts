/**
 * API Key User Info Endpoint
 *
 * @route GET /api/auth/whoami
 * @access Requires API Key (X-Feed-Api-Key header)
 *
 * @description
 * Returns the authenticated user's ID based on their API key.
 * Used by external agents/clients to discover their user ID for A2A requests.
 *
 * @openapi
 * /api/auth/whoami:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Get current user info from API key
 *     description: Returns user ID for the authenticated API key owner. Used to get the contextId for A2A requests.
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: User info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                   description: The user's unique ID (use as contextId in A2A requests)
 *                 username:
 *                   type: string
 *                   nullable: true
 *                   description: Username for debugging/logging purposes
 *       401:
 *         description: Invalid or missing API key
 *       404:
 *         description: User not found
 *
 * @example
 * ```bash
 * curl -H "X-Feed-Api-Key: YOUR_API_KEY_HERE" https://feed.market/api/auth/whoami
 * ```
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/auth/whoami', {
 *   headers: { 'X-Feed-Api-Key': apiKey }
 * });
 * const { userId } = await response.json();
 * // Use userId as contextId in A2A requests
 * ```
 */

import { validateUserApiKey, withErrorHandling } from "@feed/api";
import { db, eq, users } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET(request: NextRequest) {
  const apiKey = request.headers.get("x-feed-api-key");

  // Headers for auth responses - prevent caching of sensitive identity data
  const noCacheHeaders = { "Cache-Control": "no-store" };

  if (!apiKey) {
    return NextResponse.json(
      { error: "X-Feed-Api-Key header is required" },
      { status: 401, headers: noCacheHeaders },
    );
  }

  // Validate API key and get user ID
  const result = await validateUserApiKey(apiKey);

  if (!result) {
    return NextResponse.json(
      { error: "Invalid or expired API key" },
      { status: 401, headers: noCacheHeaders },
    );
  }

  // Fetch user details (minimal: only id and username for debugging)
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, result.userId))
    .limit(1);

  if (!user) {
    logger.warn(
      "API key valid but user not found",
      { userId: result.userId },
      "whoami",
    );
    return NextResponse.json(
      { error: "User not found" },
      { status: 404, headers: noCacheHeaders },
    );
  }

  logger.debug("Whoami request", { userId: user.id }, "whoami");

  return NextResponse.json(
    { userId: user.id, username: user.username },
    { headers: noCacheHeaders },
  );
});
