/**
 * Waitlist Email Bonus API
 *
 * @route POST /api/waitlist/bonus/email
 * @access Authenticated
 *
 * @description
 * Awards waitlist bonus points (100 points) for providing an email address.
 * One-time bonus per user. Saves email to the users table and sets the
 * pointsAwardedForEmail flag to prevent double-awarding.
 *
 * @openapi
 * /api/waitlist/bonus/email:
 *   post:
 *     tags:
 *       - Waitlist
 *     summary: Award email bonus
 *     description: Awards 100 waitlist points for providing an email address (one-time bonus)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Bonus processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 awarded:
 *                   type: boolean
 *                 bonusAmount:
 *                   type: integer
 *                   example: 100
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid or missing email
 *       401:
 *         description: Unauthorized
 *
 * @example
 * ```typescript
 * await fetch('/api/waitlist/bonus/email', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ email: 'user@example.com' }),
 * });
 * ```
 *
 * @see {@link WaitlistService.awardEmailBonus}
 */

import {
  authenticate,
  successResponse,
  WaitlistService,
  withErrorHandling,
} from '@babylon/api';
import { logger, POINTS } from '@babylon/shared';
import type { NextRequest } from 'next/server';
import { z } from 'zod';

const EmailBonusSchema = z.object({
  email: z
    .string()
    .trim()
    .email('Valid email address is required')
    .transform((value) => value.toLowerCase()),
});

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.userId;

  const body = await request.json();
  const { email } = EmailBonusSchema.parse(body);

  logger.info(
    'Email bonus request',
    { userId },
    'POST /api/waitlist/bonus/email'
  );

  const awarded = await WaitlistService.awardEmailBonus(userId, email);

  return successResponse({
    awarded,
    bonusAmount: awarded ? POINTS.EMAIL_SUBMIT : 0,
    message: awarded
      ? 'Email bonus awarded'
      : 'Email bonus already awarded or user not found',
  });
});
