/**
 * @deprecated Use auth-middleware.ts directly for Steward JWT authentication.
 *
 * This module is kept for backward compatibility. The Privy-specific functions
 * are replaced with Steward JWT equivalents. callers should migrate to using
 * authenticate() from auth-middleware.ts.
 */

import { db, eq, users } from '@babylon/db';
import { jwtVerify } from 'jose';
import { AuthenticationError } from '../../errors';

function getStewardSecret(): Uint8Array {
  return new TextEncoder().encode(
    process.env.STEWARD_JWT_SECRET ?? 'dev-jwt-secret-change-in-prod'
  );
}

export type AuthedPrivyUserContext = {
  privyId: string;
  dbUserId: string;
  isAdmin: boolean;
};

/**
 * @deprecated Use authenticate() from auth-middleware.ts.
 * Verifies a Steward JWT and returns user context.
 */
export async function getAuthedUserContextFromPrivyToken(
  token: string
): Promise<AuthedPrivyUserContext> {
  if (!token) throw new AuthenticationError('Missing token');

  let userId: string;
  try {
    const { payload } = await jwtVerify(token, getStewardSecret(), {
      issuer: 'steward',
      algorithms: ['HS256'],
    });
    userId = String(payload['userId'] ?? '');
    if (!userId) throw new Error('missing userId');
  } catch {
    throw new AuthenticationError('Invalid or expired Steward token');
  }

  const [dbUser] = await db
    .select({ id: users.id, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.stewardId, userId))
    .limit(1);

  if (!dbUser) throw new AuthenticationError('User not found');

  return {
    privyId: userId,
    dbUserId: dbUser.id,
    isAdmin: dbUser.isAdmin ?? false,
  };
}

/**
 * @deprecated Use authenticate() from auth-middleware.ts.
 */
export async function getAuthedUserContextFromPrivyTokenBundle({
  primary,
  fallback,
}: {
  primary: string;
  fallback?: string;
}): Promise<AuthedPrivyUserContext> {
  try {
    return await getAuthedUserContextFromPrivyToken(primary);
  } catch (err) {
    if (fallback && fallback !== primary) {
      return getAuthedUserContextFromPrivyToken(fallback);
    }
    throw err;
  }
}
