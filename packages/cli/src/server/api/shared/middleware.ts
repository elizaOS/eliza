import type { IAgentRuntime, UUID } from '@elizaos/core';
import express from 'express';
import { validateUuid } from '@elizaos/core';
import { sendError } from './response-utils';

/**
 * Middleware to validate that an agent exists
 */
export const agentExistsMiddleware = (agents: Map<UUID, IAgentRuntime>) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const agentId = validateUuid(req.params.agentId);
    if (!agentId) {
      return sendError(res, 400, 'INVALID_ID', 'Invalid agent ID format');
    }

    const runtime = agents.get(agentId);
    if (!runtime) {
      return sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    }

    // Add runtime to request object for use in route handlers
    (req as any).runtime = runtime;
    (req as any).agentId = agentId;
    next();
  };
};

/**
 * Middleware to validate UUID parameters
 */
export const validateUuidMiddleware = (paramName: string) => {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const paramValue = req.params[paramName];
    const validatedUuid = validateUuid(paramValue);
    
    if (!validatedUuid) {
      return sendError(res, 400, 'INVALID_ID', `Invalid ${paramName} format`);
    }

    // Add validated UUID to request params
    req.params[paramName] = validatedUuid;
    next();
  };
};