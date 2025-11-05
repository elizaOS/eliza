import crypto from 'node:crypto';

/**
 * Generate a unique session ID for authentication
 * Uses cryptographically secure random bytes
 */
export function generateSessionId(): string {
  // Generate 32 random bytes and convert to hex string
  return crypto.randomBytes(32).toString('hex');
}
