import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { twitterAutomationService } from "@/lib/services/twitter-automation";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  if (!twitterAutomationService.isConfigured()) {
    return NextResponse.json({
      configured: false,
      connected: false,
    });
  }

  const status = await twitterAutomationService.getConnectionStatus(
    user.organization_id,
  );

  return NextResponse.json({
    configured: true,
    ...status,
  });
}
