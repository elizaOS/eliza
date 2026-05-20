/**
 * MCP Agent Authentication
 *
 * Handles authentication for MCP requests using per-user API keys
 */

import { logger } from '@feed/shared';
import type { AuthenticatedAgent } from '../types/mcp';
import { validateUserApiKey } from './api-key-auth';

export interface MCPAuth {
  apiKey?: string;
}

/**
 * Authenticate agent from MCP request using API key
 */
export async function authenticateAgent(
  auth: MCPAuth
): Promise<AuthenticatedAgent | null> {
  if (!auth.apiKey) {
    logger.warn('No API key provided', undefined, 'MCP Auth');
    return null;
  }

  const validationResult = await validateUserApiKey(auth.apiKey);

  if (!validationResult) {
    logger.warn('Invalid or expired API key', undefined, 'MCP Auth');
    return null;
  }

  return {
    userId: validationResult.userId,
    agentId: validationResult.userId, // Use userId as agentId for consistency
  };
}
