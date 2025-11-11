import type { UUID } from '@elizaos/core';
import type { AgentServer } from '../index';

/**
 * Validates server_id for RLS (Row Level Security) isolation
 *
 * When ENABLE_RLS_ISOLATION is enabled, only allows access to data
 * belonging to the current server instance.
 *
 * When ENABLE_RLS_ISOLATION is disabled, allows access to all data
 * (backward compatibility mode).
 *
 * @param server_id - The server ID from the request
 * @param serverInstance - The current AgentServer instance
 * @returns true if the server_id is valid for this request, false otherwise
 *
 * @example
 * const isValid = validateServerIdForRls(req.body.server_id, serverInstance);
 * if (!isValid) {
 *   return res.status(403).json({ error: 'Forbidden: server_id does not match' });
 * }
 */
export function validateServerIdForRls(
  server_id: UUID | string | undefined,
  serverInstance: AgentServer
): boolean {
  const rlsEnabled = process.env.ENABLE_RLS_ISOLATION === 'true';

  // If RLS is disabled, allow all server_ids (backward compatibility)
  if (!rlsEnabled) {
    return true;
  }

  // If RLS is enabled, only allow matching server_id
  return server_id === serverInstance.serverId;
}

/**
 * Checks if RLS (Row Level Security) isolation is enabled
 *
 * @returns true if ENABLE_RLS_ISOLATION=true, false otherwise
 */
export function isRlsEnabled(): boolean {
  return process.env.ENABLE_RLS_ISOLATION === 'true';
}