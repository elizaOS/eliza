/** Authenticated UI transport over the public SDK referral contract. */
import {
  parseReferralMeResponse,
  REFERRALS_ME_API_PATH,
  type ReferralMeResponse,
} from "@elizaos/cloud-sdk/contracts";
import { api } from "../../lib/api-client";

export type { ReferralMeResponse } from "@elizaos/cloud-sdk/contracts";

/**
 * Authenticated GET `/api/v1/referrals`. Throws on network / HTTP / parse
 * errors (the {@link api} client throws `ApiError` on non-2xx).
 */
export async function fetchReferralMe(): Promise<ReferralMeResponse> {
  const json = await api<unknown>(REFERRALS_ME_API_PATH);
  const parsed = parseReferralMeResponse(json);
  if (!parsed) {
    throw new Error("Invalid response from server");
  }
  return parsed;
}
