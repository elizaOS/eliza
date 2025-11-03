import type { Request, Response, NextFunction } from 'express';
import { logger, type UUID } from '@elizaos/core';

export interface EntityContextRequest extends Request {
  entityId?: UUID;
  userId?: UUID; // From JWT (Phase 2)
  isServerAuthenticated?: boolean; // From API Key
}

/**
 * Middleware to extract entity ID from request.
 *
 * Entity ID can come from (priority order):
 * 1. JWT token (req.userId)
 * 2. Request body (author_id)
 *
 * The extracted entity ID is stored in req.entityId for use in database operations.
 *
 * Note: If no entity ID is found, the request proceeds as a server operation (NULL entity context).
 */
export function entityContextMiddleware(
  req: EntityContextRequest,
  _res: Response,
  next: NextFunction
): void {
  // Extract entity ID from trusted sources only
  const entityId =
    req.userId ||                    // From JWT
    req.body?.author_id;             // From message body

  if (entityId) {
    req.entityId = entityId as UUID;
    logger.debug(`[Entity Context] Extracted entity ID: ${entityId}`);
  } else {
    // No entity context - server operation (admin/system)
    logger.debug('[Entity Context] No entity ID provided (server operation)');
  }

  next();
}