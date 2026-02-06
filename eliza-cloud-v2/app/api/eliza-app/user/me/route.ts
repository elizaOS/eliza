/**
 * Eliza App - Current User Info Endpoint
 *
 * Returns the current user's profile and organization info.
 * Requires a valid session token in the Authorization header.
 *
 * GET /api/eliza-app/user/me
 */

import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { RateLimitPresets, withRateLimit } from "@/lib/middleware/rate-limit";
import { elizaAppSessionService, elizaAppUserService } from "@/lib/services/eliza-app";
import { organizationsRepository } from "@/db/repositories/organizations";

/**
 * Success response type
 */
interface UserInfoResponse {
  user: {
    id: string;
    telegram_id: string | null;
    telegram_username: string | null;
    telegram_first_name: string | null;
    phone_number: string | null;
    name: string | null;
    avatar: string | null;
    organization_id: string | null;
    created_at: string;
  };
  organization: {
    id: string;
    name: string;
    credit_balance: string;
  } | null;
}

/**
 * Error response type
 */
interface ErrorResponse {
  error: string;
  code: string;
}

async function handleGetUser(
  request: NextRequest,
): Promise<NextResponse<UserInfoResponse | ErrorResponse>> {
  // Extract Authorization header
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return NextResponse.json(
      { error: "Authorization header required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  // Validate session
  const session = await elizaAppSessionService.validateAuthHeader(authHeader);

  if (!session) {
    return NextResponse.json(
      { error: "Invalid or expired session", code: "INVALID_SESSION" },
      { status: 401 },
    );
  }

  // Get user with organization
  const user = await elizaAppUserService.getById(session.userId);

  if (!user) {
    logger.warn("[ElizaApp UserMe] User not found", {
      userId: session.userId,
    });
    return NextResponse.json(
      { error: "User not found", code: "USER_NOT_FOUND" },
      { status: 404 },
    );
  }

  // Get organization details
  let organization = null;
  if (user.organization_id) {
    const org = await organizationsRepository.findById(user.organization_id);
    if (org) {
      organization = {
        id: org.id,
        name: org.name,
        credit_balance: org.credit_balance,
      };
    }
  }

  return NextResponse.json({
    user: {
      id: user.id,
      telegram_id: user.telegram_id,
      telegram_username: user.telegram_username,
      telegram_first_name: user.telegram_first_name,
      phone_number: user.phone_number,
      name: user.name,
      avatar: user.avatar,
      organization_id: user.organization_id,
      created_at: user.created_at.toISOString(),
    },
    organization,
  });
}

// Export with standard rate limiting
export const GET = withRateLimit(handleGetUser, RateLimitPresets.STANDARD);
