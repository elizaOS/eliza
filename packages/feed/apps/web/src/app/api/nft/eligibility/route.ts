import { authenticate, successResponse, withErrorHandling } from "@feed/api";
import { checkEligibility } from "@feed/api/services/nft-mint-service";
import { toISO } from "@feed/shared";
import type { NextRequest } from "next/server";
import type { EligibilityApiResponse, EligibilityResponse } from "@/types/nft";

export const GET = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticate(request);
  const userId = authUser.dbUserId ?? authUser.userId;

  let result: Awaited<ReturnType<typeof checkEligibility>>;
  try {
    result = await checkEligibility(userId);
  } catch (error) {
    const causeCode = (error as { cause?: { code?: string } } | null)?.cause
      ?.code;
    const code = causeCode ?? (error as { code?: string } | null)?.code;

    // Missing tables/columns in the DB should not surface as a hard 500 on the waitlist host.
    if (code === "42P01" || code === "42703") {
      const payload = {
        eligible: false,
        status: "not_eligible",
        hasMinted: false,
        reason: "snapshot_unavailable",
      } satisfies EligibilityResponse;

      return successResponse({
        success: true,
        data: payload,
      } satisfies EligibilityApiResponse);
    }
    throw error;
  }

  const payload = {
    eligible: result.eligible,
    status: result.status,
    ...(result.snapshotRank != null && { snapshotRank: result.snapshotRank }),
    ...(result.snapshotPoints != null && {
      snapshotPoints: result.snapshotPoints,
    }),
    ...(result.snapshotTakenAt != null && {
      snapshotTakenAt: toISO(result.snapshotTakenAt),
    }),
    hasMinted: result.hasMinted,
    ...(result.mintedNft && { mintedNft: result.mintedNft }),
    ...(result.reason && { reason: result.reason }),
  } satisfies EligibilityResponse;

  return successResponse({
    success: true,
    data: payload,
  } satisfies EligibilityApiResponse);
});
