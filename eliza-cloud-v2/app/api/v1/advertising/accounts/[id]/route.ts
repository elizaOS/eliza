import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { advertisingService } from "@/lib/services/advertising";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/v1/advertising/accounts/[id]
 * Gets a specific ad account.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  const account = await advertisingService.getAccount(id);

  if (!account || account.organization_id !== user.organization_id) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: account.id,
    platform: account.platform,
    externalAccountId: account.external_account_id,
    accountName: account.account_name,
    status: account.status,
    metadata: account.metadata,
    createdAt: account.created_at.toISOString(),
    updatedAt: account.updated_at.toISOString(),
  });
}

/**
 * DELETE /api/v1/advertising/accounts/[id]
 * Disconnects an ad account.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { id } = await params;

  await advertisingService.disconnectAccount(id, user.organization_id!);

  logger.info("[Advertising API] Account disconnected", { accountId: id });

  return NextResponse.json({ success: true });
}
