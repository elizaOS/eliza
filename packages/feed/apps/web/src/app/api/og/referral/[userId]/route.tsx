/**
 * OG Referral Image API
 *
 * @route GET /api/og/referral/[userId] - Generate referral OG image
 * @access Public
 *
 * @description
 * Generates Open Graph image for referral sharing. Returns PNG image
 * with user referral information. Cached for 1 hour.
 *
 * @openapi
 * /api/og/referral/{userId}:
 *   get:
 *     tags:
 *       - OG Images
 *     summary: Generate referral OG image
 *     description: Generates OG image for referral sharing
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: Image generated successfully
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: User not found
 *
 * @example
 * ```typescript
 * // Use in <img> tag or meta tag
 * <img src={`/api/og/referral/${userId}`} />
 * ```
 */

import { withErrorHandling } from '@babylon/api';
import { db } from '@babylon/db';
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

// Use Node.js runtime for full database support
export const runtime = 'nodejs';

// Disable static generation for this route - it requires database access
export const dynamic = 'force-dynamic';
// Cache for 1 hour
export const revalidate = 3600;

export const GET = withErrorHandling(async function GET(
  _request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  const { userId } = await context.params;

  const [user, referralCount] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        profileImageUrl: true,
        reputationPoints: true,
      },
    }),
    db.referral.count({
      where: { referrerId: userId },
    }),
  ]);

  const displayName = user?.displayName || user?.username || 'A Babylon Trader';

  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #0B1C3D 0%, #1a2942 100%)',
        fontFamily: 'Inter, sans-serif',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'radial-gradient(circle at 20% 50%, rgba(99, 102, 241, 0.1) 0%, transparent 50%)',
          display: 'flex',
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 40,
          left: 40,
          fontSize: 28,
          fontWeight: 'bold',
          color: 'white',
          display: 'flex',
        }}
      >
        Babylon
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          zIndex: 1,
        }}
      >
        {user?.profileImageUrl && (
          <img
            src={user.profileImageUrl}
            alt={displayName}
            style={{
              width: 140,
              height: 140,
              borderRadius: '50%',
              border: '5px solid rgba(99, 102, 241, 0.3)',
              marginBottom: 30,
            }}
          />
        )}

        <div
          style={{
            fontSize: 56,
            fontWeight: 'bold',
            color: 'white',
            textAlign: 'center',
            marginBottom: 20,
            display: 'flex',
          }}
        >
          Join Me on Babylon
        </div>

        <div
          style={{
            fontSize: 32,
            color: 'rgba(255, 255, 255, 0.8)',
            marginBottom: 50,
            display: 'flex',
          }}
        >
          Invited by {displayName}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 30,
            marginTop: 20,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 30,
              borderRadius: 16,
              background: 'rgba(99, 102, 241, 0.1)',
              border: '2px solid rgba(99, 102, 241, 0.3)',
              minWidth: 200,
            }}
          >
            <div
              style={{
                fontSize: 20,
                color: 'rgba(255, 255, 255, 0.7)',
                marginBottom: 10,
                display: 'flex',
              }}
            >
              Points
            </div>
            <div
              style={{
                fontSize: 48,
                fontWeight: 'bold',
                color: '#FCD34D',
                display: 'flex',
              }}
            >
              {(user?.reputationPoints || 0).toLocaleString()}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 30,
              borderRadius: 16,
              background: 'rgba(99, 102, 241, 0.1)',
              border: '2px solid rgba(99, 102, 241, 0.3)',
              minWidth: 200,
            }}
          >
            <div
              style={{
                fontSize: 20,
                color: 'rgba(255, 255, 255, 0.7)',
                marginBottom: 10,
                display: 'flex',
              }}
            >
              Referrals
            </div>
            <div
              style={{
                fontSize: 48,
                fontWeight: 'bold',
                color: '#6366F1',
                display: 'flex',
              }}
            >
              {referralCount}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 50,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 15,
        }}
      >
        <div
          style={{
            fontSize: 24,
            color: 'rgba(255, 255, 255, 0.9)',
            fontWeight: 600,
            display: 'flex',
          }}
        >
          Trade Narratives, Share the Upside
        </div>
        <div
          style={{
            fontSize: 18,
            color: 'rgba(255, 255, 255, 0.6)',
            display: 'flex',
          }}
        >
          Click to join and start earning rewards
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
    }
  );
});
