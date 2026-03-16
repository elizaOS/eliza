import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import { cache } from "@/lib/cache/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  if (!twitterAutomationService.isConfigured()) {
    return NextResponse.json(
      { error: "Twitter integration is not configured on this platform" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const redirectUrl = body.redirectUrl || "/dashboard/settings?tab=connections";

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";
  const callbackUrl = `${baseUrl}/api/v1/twitter/callback`;

  const authLink = await twitterAutomationService.generateAuthLink(callbackUrl);

  const stateKey = `twitter_oauth:${authLink.oauthToken}`;
  await cache.set(
    stateKey,
    JSON.stringify({
      oauthTokenSecret: authLink.oauthTokenSecret,
      organizationId: user.organization_id,
      userId: user.id,
      redirectUrl,
    }),
    { ex: 600 },
  );

  return NextResponse.json({
    authUrl: authLink.url,
    oauthToken: authLink.oauthToken,
  });
}
