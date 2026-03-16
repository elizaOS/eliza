/**
 * GET /api/v1/oauth/providers
 *
 * List all available OAuth providers with their configuration status.
 * Public endpoint - no authentication required.
 */

import { NextResponse } from "next/server";
import { oauthService } from "@/lib/services/oauth";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ providers: oauthService.listProviders() });
}
