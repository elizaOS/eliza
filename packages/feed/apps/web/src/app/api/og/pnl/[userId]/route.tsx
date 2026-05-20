/**
 * OG P&L Image API
 *
 * @route GET /api/og/pnl/[userId] - Generate P&L OG image
 * @access Public
 *
 * @description
 * Generates Open Graph image for P&L sharing. Returns PNG image with
 * portfolio profit/loss information. Cached for 1 hour.
 *
 * @openapi
 * /api/og/pnl/{userId}:
 *   get:
 *     tags:
 *       - OG Images
 *     summary: Generate P&L OG image
 *     description: Generates OG image for portfolio P&L sharing
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
 * <img src={`/api/og/pnl/${userId}`} />
 * ```
 */

import { withErrorHandling } from '@babylon/api';
import { db } from '@babylon/db';
import { calculatePortfolioBreakdown } from '@babylon/engine';
import { ImageResponse } from 'next/og';
import type { NextRequest } from 'next/server';

// Use Node.js runtime for full database support
export const runtime = 'nodejs';

// Disable static generation for this route - it requires database access
export const dynamic = 'force-dynamic';
// Cache for 1 hour, revalidate in background
export const revalidate = 3600;

export const GET = withErrorHandling(async function GET(
  _request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  const { userId } = await context.params;

  const [user, pnlData] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        profileImageUrl: true,
      },
    }),
    calculatePortfolioBreakdown(userId),
  ]);

  const displayName = user?.displayName || user?.username || 'Babylon User';
  const totalPnL = pnlData?.totalPnL || 0;
  const totalAssets = pnlData?.totalAssets || 0;
  const availableBalance = pnlData?.available || 0;
  const pnlSign = totalPnL >= 0 ? '+' : '';
  const pnlColor = totalPnL >= 0 ? '#10B981' : '#EF4444';

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
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 40,
          left: 40,
          fontSize: 32,
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
          marginBottom: 60,
        }}
      >
        {user?.profileImageUrl && (
          <img
            src={user.profileImageUrl}
            alt={displayName}
            style={{
              width: 120,
              height: 120,
              borderRadius: '50%',
              border: '4px solid rgba(255, 255, 255, 0.1)',
              marginBottom: 20,
            }}
          />
        )}
        <div
          style={{
            fontSize: 36,
            fontWeight: 'bold',
            color: 'white',
            marginBottom: 8,
            display: 'flex',
          }}
        >
          {displayName}
        </div>
        {user?.username && (
          <div
            style={{
              fontSize: 24,
              color: 'rgba(255, 255, 255, 0.6)',
              display: 'flex',
            }}
          >
            @{user.username}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
          width: '80%',
          maxWidth: 800,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: 40,
            borderRadius: 20,
            background: 'rgba(255, 255, 255, 0.05)',
            border: '2px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          <div
            style={{
              fontSize: 24,
              color: 'rgba(255, 255, 255, 0.7)',
              marginBottom: 12,
              display: 'flex',
            }}
          >
            Total P&L
          </div>
          <div
            style={{
              fontSize: 72,
              fontWeight: 'bold',
              color: pnlColor,
              display: 'flex',
            }}
          >
            {pnlSign}${Math.abs(totalPnL).toFixed(2)}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 24,
            width: '100%',
          }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 30,
              borderRadius: 16,
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div
              style={{
                fontSize: 18,
                color: 'rgba(255, 255, 255, 0.6)',
                marginBottom: 8,
                display: 'flex',
              }}
            >
              Total Assets
            </div>
            <div
              style={{
                fontSize: 36,
                fontWeight: 'bold',
                color: 'white',
                display: 'flex',
              }}
            >
              ${totalAssets.toFixed(2)}
            </div>
          </div>

          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 30,
              borderRadius: 16,
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div
              style={{
                fontSize: 18,
                color: 'rgba(255, 255, 255, 0.6)',
                marginBottom: 8,
                display: 'flex',
              }}
            >
              Trading Balance
            </div>
            <div
              style={{
                fontSize: 36,
                fontWeight: 'bold',
                color: 'white',
                display: 'flex',
              }}
            >
              ${availableBalance.toFixed(2)}
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 40,
          display: 'flex',
          fontSize: 20,
          color: 'rgba(255, 255, 255, 0.5)',
        }}
      >
        Trading narratives, sharing the upside
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
    }
  );
});
