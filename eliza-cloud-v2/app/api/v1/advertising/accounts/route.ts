import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  advertisingService,
  type AdPlatform,
} from "@/lib/services/advertising";
import { ConnectAccountSchema } from "@/lib/services/advertising/schemas";
import { logger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/advertising/accounts
 * Lists connected ad accounts for the organization.
 */
export async function GET(request: NextRequest) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const searchParams = request.nextUrl.searchParams;
  const platform = searchParams.get("platform") as AdPlatform | null;

  const accounts = await advertisingService.listAccounts(
    user.organization_id!,
    platform ? { platform } : undefined,
  );

  return NextResponse.json({
    accounts: accounts.map((a) => ({
      id: a.id,
      platform: a.platform,
      externalAccountId: a.external_account_id,
      accountName: a.account_name,
      status: a.status,
      createdAt: a.created_at.toISOString(),
    })),
    count: accounts.length,
  });
}

/**
 * POST /api/v1/advertising/accounts
 * Connects a new ad account.
 */
export async function POST(request: NextRequest) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);

  const body = await request.json();
  const parsed = ConnectAccountSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const account = await advertisingService.connectAccount({
    organizationId: user.organization_id!,
    userId: user.id,
    platform: parsed.data.platform,
    accessToken: parsed.data.accessToken,
    refreshToken: parsed.data.refreshToken,
    externalAccountId: parsed.data.externalAccountId,
    accountName: parsed.data.accountName,
  });

  logger.info("[Advertising API] Account connected", {
    accountId: account.id,
    platform: account.platform,
  });

  return NextResponse.json(
    {
      id: account.id,
      platform: account.platform,
      externalAccountId: account.external_account_id,
      accountName: account.account_name,
      status: account.status,
      createdAt: account.created_at.toISOString(),
    },
    { status: 201 },
  );
}
