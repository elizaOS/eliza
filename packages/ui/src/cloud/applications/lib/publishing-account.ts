/**
 * Reads and validates account-level publishing context for project management.
 *
 * Affiliate attribution and redeemable earnings belong to the signed-in owner,
 * not an individual project. This boundary keeps their Cloud wire shapes out of
 * React and derives share links from the configured public console origin so a
 * native WebView never leaks its synthetic bundle URL.
 */

import type {
  AffiliateCodeResponse,
  RedemptionBalanceResponse,
} from "@elizaos/cloud-sdk";
import { api } from "../../lib/api-client";
import { resolveCloudConsoleUrl } from "./native-cloud-nav";

export interface PublishingAffiliateCode {
  code: string;
  /** Older typed responses omit activity state; `false` is the only disabled signal. */
  isActive: boolean | null;
}

export interface PublishingAccountData {
  affiliate: PublishingAffiliateCode | null;
  availableBalance: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAffiliateCode(
  response: AffiliateCodeResponse,
): PublishingAffiliateCode | null {
  const value = response.code;
  if (value === null) return null;
  if (typeof value === "string") {
    const code = value.trim();
    if (!code) throw new Error("Cloud returned an empty affiliate code");
    return { code, isActive: null };
  }
  if (!isRecord(value)) {
    throw new Error("Cloud returned an invalid affiliate response");
  }
  const code = value.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("Cloud returned an invalid affiliate code");
  }
  const rawActive = value.is_active ?? value.isActive;
  if (rawActive !== undefined && typeof rawActive !== "boolean") {
    throw new Error("Cloud returned an invalid affiliate activity state");
  }
  return {
    code: code.trim(),
    isActive: rawActive ?? null,
  };
}

function readAvailableBalance(response: RedemptionBalanceResponse): number {
  if (response.success !== true || !isRecord(response.balance)) {
    throw new Error("Cloud returned an invalid redeemable-balance response");
  }
  const availableBalance = response.balance.availableBalance;
  if (
    typeof availableBalance !== "number" ||
    !Number.isFinite(availableBalance) ||
    availableBalance < 0
  ) {
    throw new Error("Cloud returned an invalid redeemable balance");
  }
  return availableBalance;
}

/** Fetch the owner-level affiliate and earnings context in one observable read. */
export async function getPublishingAccountData(): Promise<PublishingAccountData> {
  const [affiliate, earnings] = await Promise.all([
    api<AffiliateCodeResponse>("/api/v1/affiliates"),
    api<RedemptionBalanceResponse>("/api/v1/redemptions/balance"),
  ]);
  return {
    affiliate: readAffiliateCode(affiliate),
    availableBalance: readAvailableBalance(earnings),
  };
}

/** Public signup URL that attributes new users to the owner's affiliate code. */
export function publishingAffiliateUrl(code: string): string {
  return resolveCloudConsoleUrl(
    `/login?affiliate=${encodeURIComponent(code.trim())}`,
  );
}
