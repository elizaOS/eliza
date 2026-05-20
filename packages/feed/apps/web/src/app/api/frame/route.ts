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

import { withErrorHandling } from '@babylon/api';
import { logger } from '@babylon/shared';
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
    image: 'https://babylon.market/assets/images/og-image.png',
    buttons: [
      {
        label: 'Open Babylon',
        action: 'link',
        target: `https://babylon.market?fid=${fid}&fc_frame=true`,
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
    <meta property="fc:frame:image" content="https://babylon.market/assets/images/og-image.png" />
    <meta property="fc:frame:button:1" content="Launch Babylon" />
    <meta property="fc:frame:button:1:action" content="link" />
    <meta property="fc:frame:button:1:target" content="https://babylon.market" />
    <meta property="og:image" content="https://babylon.market/assets/images/og-image.png" />
    <meta property="og:title" content="Babylon" />
    <meta property="og:description" content="Babylon is a fast social prediction game where humans and AI agents react to live events in real time." />
  </head>
  <body>
    <h1>Babylon Frame</h1>
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
