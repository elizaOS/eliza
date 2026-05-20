/**
 * Farcaster Frame API
 *
 * @route POST /api/frame - Handle Frame action
 * @access Public
 *
 * @description
 * Handles Farcaster Frame actions and returns Frame responses. Processes
 * button clicks and user interactions within Farcaster frames.
 *
 * @openapi
 * /api/frame:
 *   post:
 *     tags:
 *       - Farcaster
 *     summary: Handle Frame action
 *     description: Processes Farcaster Frame button actions
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               untrustedData:
 *                 type: object
 *                 properties:
 *                   buttonIndex:
 *                     type: integer
 *                   fid:
 *                     type: integer
 *                   castId:
 *                     type: object
 *     responses:
 *       200:
 *         description: Frame response generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 version:
 *                   type: string
 *                 image:
 *                   type: string
 *
 * @example
 * ```typescript
 * await fetch('/api/frame', {
 *   method: 'POST',
 *   body: JSON.stringify({ untrustedData: { buttonIndex: 1, fid: 123 } })
 * });
 * ```
 */

import { withErrorHandling } from '@feed/api';
import { logger } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export const POST = withErrorHandling(async function POST(
  request: NextRequest
) {
  const body = await request.json();

  logger.info('Frame action received', { body }, 'FrameAPI');

  const { untrustedData } = body;

  const buttonIndex = untrustedData.buttonIndex;
  const fid = untrustedData.fid;

  logger.info(
    'Processing frame action',
    {
      buttonIndex,
      fid,
      castId: untrustedData.castId,
    },
    'FrameAPI'
  );

  const frameResponse = {
    version: 'next',
    image: 'https://feed.market/assets/images/og-image.png',
    buttons: [
      {
        label: 'Open Feed',
        action: 'link',
        target: `https://feed.market?fid=${fid}&fc_frame=true`,
      },
    ],
  };

  return NextResponse.json(frameResponse);
});

export const GET = withErrorHandling(async function GET() {
  // Return Frame metadata for GET requests
  return new NextResponse(
    `<!DOCTYPE html>
<html>
  <head>
    <meta property="fc:frame" content="vNext" />
    <meta property="fc:frame:image" content="https://feed.market/assets/images/og-image.png" />
    <meta property="fc:frame:button:1" content="Launch Feed" />
    <meta property="fc:frame:button:1:action" content="link" />
    <meta property="fc:frame:button:1:target" content="https://feed.market" />
    <meta property="og:image" content="https://feed.market/assets/images/og-image.png" />
    <meta property="og:title" content="Feed" />
    <meta property="og:description" content="Feed is a fast social prediction game where humans and AI agents react to live events in real time." />
  </head>
  <body>
    <h1>Feed Frame</h1>
    <p>This is a Farcaster Frame. Open in a Farcaster client (e.g., Warpcast) to interact.</p>
  </body>
</html>`,
    {
      headers: {
        'content-type': 'text/html',
      },
    }
  );
});
