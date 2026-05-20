/**
 * A2A API Key Authentication Utilities
 *
 * Supports two authentication methods:
 * 1. Server secret (BABYLON_A2A_API_KEY) - for server-to-server communication
 * 2. Per-user API keys (from userApiKeys table) - for user-specific operations
 *
 * Uses shared cached validation from @babylon/api for efficiency.
 */

import {
  clearApiKeyCache,
  getApiKeyCacheStats,
  invalidateCachedKey,
  invalidateCachedKeysForUser,
  validateUserApiKey,
} from '@babylon/api';
import { logger } from '@babylon/shared';
import crypto from 'crypto';

/**
 * Timing-safe comparison for API keys to prevent timing attacks.
 *
 * Uses SHA-256 hashing to produce fixed-length digests before comparison,
 * preventing length leakage via early returns. This ensures constant-time
 * comparison regardless of input lengths.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Hash both inputs to fixed-length 32-byte SHA-256 digests
  // This prevents length leakage and ensures constant-time comparison
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Re-export cache utilities from @babylon/api
export {
  clearApiKeyCache,
  getApiKeyCacheStats,
  invalidateCachedKey,
  invalidateCachedKeysForUser,
  validateUserApiKey,
};

export const A2A_API_KEY_HEADER = 'x-babylon-api-key';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for API key authentication
 */
export interface ApiKeyAuthConfig {
  /** Server-wide API key (BABYLON_A2A_API_KEY) */
  serverApiKey?: string;
  /** Allow localhost without authentication */
  allowLocalhost?: boolean;
  /** Check per-user API keys from database */
  allowUserApiKeys?: boolean;
}

/**
 * Request-like interface for generic handling
 */
export interface AuthRequest {
  headers: {
    get(name: string): string | null;
  };
  host?: string;
}

/**
 * Authentication result with optional user context
 */
export interface AuthResult {
  authenticated: boolean;
  /** Authentication method used */
  authMethod?: 'localhost' | 'server-key' | 'user-key';
  /** User ID if authenticated via per-user API key */
  userId?: string;
  error?: string;
  statusCode?: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if host is localhost
 */
export function isLocalHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const lowerHost = host.toLowerCase();
  return (
    lowerHost.startsWith('localhost') ||
    lowerHost.startsWith('127.0.0.1') ||
    lowerHost.startsWith('::1')
  );
}

// ============================================================================
// API Key Validation
// ============================================================================

/**
 * Validate API key from request headers (synchronous, server key only)
 *
 * @param request - Request with headers
 * @param config - Authentication configuration
 * @returns Authentication result
 */
export function validateApiKey(
  request: AuthRequest,
  config: ApiKeyAuthConfig = {}
): AuthResult {
  const { serverApiKey, allowLocalhost = true } = config;

  const host = request.host ?? request.headers.get('host');

  if (allowLocalhost && isLocalHost(host)) {
    return { authenticated: true, authMethod: 'localhost' };
  }

  const providedKey = request.headers.get(A2A_API_KEY_HEADER);

  // Timing-safe comparison to prevent timing attacks
  if (
    serverApiKey &&
    providedKey &&
    timingSafeEqual(providedKey, serverApiKey)
  ) {
    return { authenticated: true, authMethod: 'server-key' };
  }

  if (!providedKey) {
    return {
      authenticated: false,
      error: 'Unauthorized: X-Babylon-Api-Key header is required',
      statusCode: 401,
    };
  }

  return {
    authenticated: false,
    error: 'Unauthorized: Invalid API key',
    statusCode: 401,
  };
}

/**
 * Validate API key from request headers (async, supports both server and user keys)
 *
 * Checks in order:
 * 1. Localhost bypass (if enabled)
 * 2. Server API key (BABYLON_A2A_API_KEY)
 * 3. Per-user API key (from database, cached)
 *
 * @param request - Request with headers
 * @param config - Authentication configuration
 * @returns Authentication result with user context if applicable
 */
export async function validateApiKeyAsync(
  request: AuthRequest,
  config: ApiKeyAuthConfig = {}
): Promise<AuthResult> {
  const {
    serverApiKey,
    allowLocalhost = true,
    allowUserApiKeys = true,
  } = config;

  const host = request.host ?? request.headers.get('host');

  if (allowLocalhost && isLocalHost(host)) {
    return { authenticated: true, authMethod: 'localhost' };
  }

  const providedKey = request.headers.get(A2A_API_KEY_HEADER);

  if (!providedKey) {
    logger.warn('No API key provided', { host }, 'A2AAuth');
    return {
      authenticated: false,
      error: 'Unauthorized: X-Babylon-Api-Key header is required',
      statusCode: 401,
    };
  }

  // Check server API key first (fast path, timing-safe comparison)
  if (serverApiKey && timingSafeEqual(providedKey, serverApiKey)) {
    logger.debug('Authenticated via server API key', {}, 'A2AAuth');
    return { authenticated: true, authMethod: 'server-key' };
  }

  // Check per-user API key (cached lookup from @babylon/api)
  if (allowUserApiKeys) {
    const userKeyResult = await validateUserApiKey(providedKey);
    if (userKeyResult) {
      logger.debug(
        'Authenticated via user API key',
        { userId: userKeyResult.userId },
        'A2AAuth'
      );
      return {
        authenticated: true,
        authMethod: 'user-key',
        userId: userKeyResult.userId,
      };
    }
  }

  logger.warn(
    'Invalid A2A API key',
    {
      // Only log non-secret metadata - never log key prefix or content
      providedLength: providedKey.length,
      serverKeyConfigured: Boolean(serverApiKey),
      userKeysEnabled: allowUserApiKeys,
    },
    'A2AAuth'
  );

  return {
    authenticated: false,
    error: 'Unauthorized: Invalid API key',
    statusCode: 401,
  };
}

/**
 * Get the server API key from environment
 */
export function getServerApiKey(): string | undefined {
  return process.env.BABYLON_A2A_API_KEY;
}

/**
 * @deprecated Use getServerApiKey instead
 */
export function getRequiredApiKey(): string | undefined {
  return getServerApiKey();
}
