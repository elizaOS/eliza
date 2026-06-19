/**
 * Farcaster Frame Metadata API
 *
 * @route GET /api/frame/metadata - Get Frame metadata
 * @access Public
 *
 * @description
 * Returns Frame metadata for Farcaster apps including name, icon, splash
 * image, and home URL. Used for Frame discovery and configuration.
 *
 * @openapi
 * /api/frame/metadata:
 *   get:
 *     tags:
 *       - Farcaster
 *     summary: Get Frame metadata
 *     description: Returns Frame metadata for Farcaster apps
 *     responses:
 *       200:
 *         description: Metadata retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:
 *                   type: string
 *                 icon:
 *                   type: string
 *                   format: uri
 *                 splashImage:
 *                   type: string
 *                   format: uri
 *                 splashBackgroundColor:
 *                   type: string
 *                 homeUrl:
 *                   type: string
 *                   format: uri
 *                 version:
 *                   type: string
 *
 * @example
 * ```typescript
 * const metadata = await fetch('/api/frame/metadata').then(r => r.json());
 * ```
 */

import { withErrorHandling } from "@feed/api";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export const GET = withErrorHandling(async function GET() {
  const metadata = {
    name: "Feed",
    icon: "https://feed.market/assets/logos/logo.svg",
    splashImage: "https://feed.market/assets/images/og-image.png",
    splashBackgroundColor: "#0a0a0a",
    homeUrl: "https://feed.market",
    version: "next",
  };

  return NextResponse.json(metadata, {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
});
