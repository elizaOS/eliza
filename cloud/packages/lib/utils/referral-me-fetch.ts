import { parseReferralMeResponse, type ReferralMeResponse } from "@/lib/types/referral-me";

export const REFERRALS_ME_API_PATH = "/api/v1/referrals";

/**
 * Error thrown when the API returns an HTTP error response.
 * Exposes `status` so callers can distinguish 401 from 403, etc.
 */
export class ApiResponseError extends Error {
  readonly status: number;
  readonly serverMessage?: string;

  constructor(status: number, serverMessage?: string) {
    const message = serverMessage || `Request failed (${status})`;
    super(message);
    this.name = "ApiResponseError";
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

/**
 * Authenticated GET `/api/v1/referrals` from the browser. Throws on network/HTTP/parse errors.
 */
export async function fetchReferralMe(): Promise<ReferralMeResponse> {
  const res = await fetch(REFERRALS_ME_API_PATH, {
    method: "GET",
    credentials: "include",
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiResponseError(res.status, errBody.error);
  }
  const json = await res.json();
  const parsed = parseReferralMeResponse(json);
  if (!parsed) {
    throw new Error("Invalid response from server");
  }
  return parsed;
}
