/**
 * Agent Authentication API
 *
 * @route POST /api/agents/auth - Authenticate agent
 * @access Public (with credentials)
 *
 * @description
 * Secure authentication endpoint for autonomous Polyagent agents. Provides
 * session-based authentication without requiring user Privy tokens. Agent
 * credentials are validated against environment variables, and successful
 * authentication returns a time-limited session token.
 *
 * @openapi
 * /api/agents/auth:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Authenticate agent
 *     description: Authenticates agent with credentials and returns session token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - agentId
 *               - agentSecret
 *             properties:
 *               agentId:
 *                 type: string
 *                 description: Agent identifier
 *               agentSecret:
 *                 type: string
 *                 description: Agent secret key
 *     responses:
 *       200:
 *         description: Authentication successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 sessionToken:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 expiresIn:
 *                   type: integer
 *       400:
 *         description: Invalid request format
 *       401:
 *         description: Invalid credentials
 *
 * @example
 * ```typescript
 * const response = await fetch('/api/agents/auth', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     agentId: 'my-agent-id',
 *     agentSecret: process.env.AGENT_SECRET
 *   })
 * });
 *
 * const { sessionToken, expiresIn } = await response.json();
 *
 * // Use token for authenticated requests
 * await fetch('/api/some-endpoint', {
 *   headers: { 'Authorization': `Bearer ${sessionToken}` }
 * });
 * ```
 *
 * @see {@link /lib/auth/agent-auth} Agent authentication implementation
 * @see {@link /examples/polyagent-typescript-agent} Example agent usage
 */

import { randomBytes } from "node:crypto";
import {
  AuthorizationError,
  cleanupExpiredSessions,
  createAgentSession,
  getSessionDuration,
  successResponse,
  verifyAgentCredentials,
  withErrorHandling,
} from "@polyagent/api";
import { AgentAuthSchema, logger } from "@polyagent/shared";
import type { NextRequest } from "next/server";

/**
 * POST /api/agents/auth
 * Authenticate agent and receive session token
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const body = await request.json();

  // Check if body is empty or not an object
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(
      "Request body must be a JSON object containing agentId and agentSecret fields.",
    );
  }

  const { agentId, agentSecret } = AgentAuthSchema.parse(body);

  // Verify agent credentials
  if (!verifyAgentCredentials(agentId, agentSecret)) {
    throw new AuthorizationError(
      "Invalid agent credentials",
      "agent",
      "authenticate",
    );
  }

  // Clean up old sessions
  cleanupExpiredSessions();

  // Generate session token
  const sessionToken = randomBytes(32).toString("hex");

  // Create session
  const session = await createAgentSession(agentId, sessionToken);

  logger.info(
    `Agent ${agentId} authenticated successfully`,
    undefined,
    "POST /api/agents/auth",
  );

  return successResponse({
    success: true,
    sessionToken,
    expiresAt: session.expiresAt,
    expiresIn: getSessionDuration() / 1000, // seconds
  });
});
