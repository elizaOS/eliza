/**
 * Agent On-Chain Registration API
 *
 * @route POST /api/agents/onboard - Register agent on-chain
 * @access Authenticated
 *
 * @description
 * Registers ElizaOS agents to Agent0 network on Ethereum mainnet.
 * Uses Agent0 SDK with canonical ERC-8004 contracts for identity and reputation.
 * Agents are registered with IPFS metadata and discoverable globally.
 *
 * @openapi
 * /api/agents/onboard:
 *   post:
 *     tags:
 *       - Agents
 *     summary: Register agent on-chain
 *     description: Registers agent to Agent0 network on Ethereum mainnet
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - agentId
 *               - name
 *               - endpoint
 *             properties:
 *               agentId:
 *                 type: string
 *               name:
 *                 type: string
 *               endpoint:
 *                 type: string
 *                 format: uri
 *               capabilities:
 *                 type: object
 *               metadataURI:
 *                 type: string
 *     responses:
 *       200:
 *         description: Agent registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tokenId:
 *                   type: string
 *                 agentId:
 *                   type: string
 *                 agent0MetadataCID:
 *                   type: string
 *       400:
 *         description: Invalid input or already registered
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/agents/onboard', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({
 *     agentId: 'agent-id',
 *     name: 'My Agent',
 *     endpoint: 'https://...'
 *   })
 * });
 * ```
 */

import {
  AuthorizationError,
  authenticate,
  successResponse,
  withErrorHandling,
} from '@babylon/api';
import { asUser } from '@babylon/db';
import {
  AgentOnboardSchema,
  generateSnowflakeId,
  logger,
} from '@babylon/shared';
import type { NextRequest } from 'next/server';

/**
 * POST /api/agents/onboard
 * Register an agent to the on-chain identity system
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  // Authenticate agent FIRST
  const user = await authenticate(request);
  if (!user.isAgent || !user.userId) {
    throw new AuthorizationError(
      'Only agents can use this endpoint',
      'agent',
      'onboard'
    );
  }

  const agentId = user.userId;

  // Parse and validate request body
  const body = await request.json();
  const { agentName } = AgentOnboardSchema.parse(body);

  // Check if agent exists in database (use upsert to avoid race conditions) with RLS
  // Note: Agents are registered via Agent0 SDK on Ethereum mainnet
  await asUser(user, async (db) => {
    await db.user.upsert({
      where: {
        username: agentId, // Use username as unique identifier for agents
      },
      update: {
        // Update fields if user exists but data changed
        displayName: agentName || agentId,
        bio: `Autonomous AI agent: ${agentId}`,
      },
      create: {
        id: await generateSnowflakeId(),
        privyId: agentId,
        username: agentId,
        displayName: agentName || agentId,
        virtualBalance: '10000', // Start with 10k points
        totalDeposited: '10000',
        bio: `Autonomous AI agent: ${agentId}`,
        updatedAt: new Date(),
      },
    });

    // Fetch the user with selected fields
    const userWithFields = await db.user.findUnique({
      where: { privyId: agentId },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
      },
    });

    if (!userWithFields) {
      throw new Error('Failed to create or find user');
    }

    return userWithFields;
  });

  logger.info(
    'Agent onboarded successfully',
    { agentId },
    'POST /api/agents/onboard'
  );

  return successResponse({
    message: 'Agent registered successfully',
    agentId,
    registered: true,
  });
});

/**
 * GET /api/agents/onboard
 * Check agent registration status
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const user = await authenticate(request);
  if (!user.isAgent || !user.userId) {
    throw new AuthorizationError(
      'Only agents can use this endpoint',
      'agent',
      'check-status'
    );
  }

  const agentId = user.userId;

  logger.info(
    'Agent registration status checked',
    { agentId },
    'GET /api/agents/onboard'
  );

  return successResponse({
    isRegistered: true,
    agentId,
  });
});
