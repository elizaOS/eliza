/**
 * Waitlist Mark API
 *
 * @route POST /api/waitlist/mark - Mark user as waitlisted
 * @access Authenticated
 *
 * @description
 * Marks the authenticated user as waitlisted after completing onboarding. Processes
 * referral code if provided and awards initial waitlist points. Users should complete
 * onboarding first via /api/users/signup with isWaitlist flag.
 *
 * @openapi
 * /api/waitlist/mark:
 *   post:
 *     tags:
 *       - Waitlist
 *     summary: Mark user as waitlisted
 *     description: Marks authenticated user as waitlisted and processes referral code
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               referralCode:
 *                 type: string
 *                 description: Optional referral code
 *     responses:
 *       200:
 *         description: User marked as waitlisted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 waitlistPosition:
 *                   type: integer
 *                 inviteCode:
 *                   type: string
 *                 points:
 *                   type: number
 *                 referrerRewarded:
 *                   type: boolean
 *       400:
 *         description: Invalid input or already waitlisted
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/waitlist/mark', {
 *   method: 'POST',
 *   headers: { 'Authorization': `Bearer ${token}` },
 *   body: JSON.stringify({ referralCode: 'friend123' })
 * });
 * ```
 *
 * @see {@link /lib/services/waitlist-service} Waitlist service
 */

import {
  authenticate,
  ensureUserForAuth,
  successResponse,
  WaitlistService,
  withErrorHandling,
} from "@feed/api";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { z } from "zod";

const MarkSchema = z.object({
  referralCode: z.string().optional(),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  // Authenticate user - use authenticated user's ID, not from request body
  const authUser = await authenticate(request);

  // Ensure user exists in database (create if needed)
  const { user: dbUser } = await ensureUserForAuth(authUser, {
    displayName: authUser.walletAddress
      ? `${authUser.walletAddress.slice(0, 6)}...${authUser.walletAddress.slice(-4)}`
      : "User",
  });

  const body = (await request.json()) as { referralCode?: string };
  const { referralCode } = MarkSchema.parse(body);

  logger.info(
    "Waitlist mark request",
    {
      userId: dbUser.id,
      hasReferral: !!referralCode,
    },
    "POST /api/waitlist/mark",
  );

  const result = await WaitlistService.markAsWaitlisted(
    dbUser.id,
    referralCode,
  );

  if (!result.success) {
    throw new Error(result.error || "Failed to mark user as waitlisted");
  }

  logger.info(
    "User marked as waitlisted",
    {
      userId: dbUser.id,
      position: result.waitlistPosition,
      referrerRewarded: result.referrerRewarded,
    },
    "POST /api/waitlist/mark",
  );

  return successResponse({
    waitlistPosition: result.waitlistPosition,
    inviteCode: result.inviteCode,
    points: result.points,
    referrerRewarded: result.referrerRewarded,
  });
});
