/**
 * Admin Environment Management API
 *
 * @route GET /api/admin/environment - Get current environment info
 * @route POST /api/admin/environment - Set preferred environment
 * @access Admin
 *
 * @security DISPLAY-ONLY PREFERENCE
 * This endpoint manages the admin's UI environment preference for display purposes only.
 * It does NOT affect which database, Redis instance, or backend services are used.
 * The actual environment is determined by process.env.VERCEL_ENV and NODE_ENV.
 * The preference cookie only affects how the admin dashboard displays environment context.
 */

import {
  errorResponse,
  requireAdmin,
  requireSuperAdmin,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { logger } from '@feed/shared';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

export type AdminEnvironment = 'production' | 'staging' | 'development';

const ENVIRONMENT_COOKIE = 'admin-environment';
const VALID_ENVIRONMENTS: AdminEnvironment[] = [
  'production',
  'staging',
  'development',
];

/**
 * Get the actual environment from environment variables
 */
function getActualEnvironment(): AdminEnvironment {
  if (process.env.VERCEL_ENV === 'production') return 'production';
  if (process.env.VERCEL_ENV === 'preview') return 'staging';
  if (process.env.NODE_ENV === 'production') return 'production';
  return 'development';
}

/**
 * GET /api/admin/environment
 * Returns current environment information
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const cookieStore = await cookies();
  const preferredEnvironment = cookieStore.get(ENVIRONMENT_COOKIE)?.value as
    | AdminEnvironment
    | undefined;
  const actualEnvironment = getActualEnvironment();

  return successResponse({
    actual: actualEnvironment,
    preferred: preferredEnvironment || actualEnvironment,
    available: VALID_ENVIRONMENTS,
    info: {
      nodeEnv: process.env.NODE_ENV,
      vercelEnv: process.env.VERCEL_ENV || 'local',
      vercelUrl: process.env.VERCEL_URL || 'localhost',
      region: process.env.VERCEL_REGION || 'local',
    },
  });
});

/**
 * POST /api/admin/environment
 * Set preferred environment for admin operations
 *
 * Body:
 * - environment: 'production' | 'staging' | 'development'
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  // Environment switching is restricted to SUPER_ADMIN only
  // as it can affect data visibility and admin operations
  const admin = await requireSuperAdmin(request);

  const body = await request.json();
  const { environment } = body as { environment?: AdminEnvironment };

  if (!environment || !VALID_ENVIRONMENTS.includes(environment)) {
    return errorResponse(
      `Invalid environment. Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`,
      'INVALID_ENVIRONMENT',
      400
    );
  }

  const cookieStore = await cookies();

  // Set the environment cookie
  // Using 'strict' for sameSite to prevent CSRF attacks on this sensitive endpoint
  cookieStore.set(ENVIRONMENT_COOKIE, environment, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });

  logger.info(
    'Admin environment changed',
    {
      userId: admin.userId,
      environment,
    },
    'POST /api/admin/environment'
  );

  return successResponse({
    success: true,
    environment,
    message: `Environment preference set to ${environment}`,
  });
});
