import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { advertisingService } from "@/lib/services/advertising";
import { CreateCreativeSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/advertising/campaigns/[id]/creatives
 * Lists creatives for a campaign.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const creatives = await advertisingService.listCreatives(
    id,
    user.organization_id!,
  );

  return NextResponse.json({
    creatives: creatives.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      headline: c.headline,
      primaryText: c.primary_text,
      description: c.description,
      callToAction: c.call_to_action,
      destinationUrl: c.destination_url,
      media: c.media,
      createdAt: c.created_at.toISOString(),
    })),
    count: creatives.length,
  });
}

/**
 * POST /api/v1/advertising/campaigns/[id]/creatives
 * Creates a new creative for a campaign.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const body = await request.json();
  const parsed = CreateCreativeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const creative = await advertisingService.createCreative(
    user.organization_id!,
    {
      campaignId: id,
      name: parsed.data.name,
      type: parsed.data.type,
      headline: parsed.data.headline,
      primaryText: parsed.data.primaryText,
      description: parsed.data.description,
      callToAction: parsed.data.callToAction,
      destinationUrl: parsed.data.destinationUrl,
      media: parsed.data.media,
    },
  );

  logger.info("[Advertising API] Creative created", {
    creativeId: creative.id,
    campaignId: id,
  });

  return NextResponse.json(
    {
      id: creative.id,
      name: creative.name,
      type: creative.type,
      status: creative.status,
      createdAt: creative.created_at.toISOString(),
    },
    { status: 201 },
  );
}
