"use client";

import { logger } from "@feed/shared";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import {
  readStorageItem,
  removeStorageItem,
  writeStorageItem,
} from "@/utils/browser-storage";

/**
 * Referral capture provider component for capturing referral codes from URL.
 *
 * Captures the referral code from URL query parameter (?ref=CODE) and stores
 * it in sessionStorage for use during signup/onboarding. Ensures the referral
 * code persists across navigation until the user completes signup. Automatically
 * cleans up expired referral codes (older than 30 days).
 *
 * Features:
 * - URL parameter capture
 * - SessionStorage persistence
 * - Expiration handling (30 days)
 * - Timestamp tracking
 *
 * @returns null (does not render anything)
 */
export function ReferralCaptureProvider() {
  const searchParams = useSearchParams();

  useEffect(() => {
    // Get referral code from URL
    const refCode = searchParams.get("ref");

    if (refCode) {
      // Store in sessionStorage (persists until browser tab is closed)
      writeStorageItem("sessionStorage", "referralCode", refCode);

      logger.info(
        `Captured referral code: ${refCode}`,
        { code: refCode },
        "ReferralCaptureProvider",
      );

      // Also store timestamp to track how old the referral is
      writeStorageItem(
        "sessionStorage",
        "referralCodeTimestamp",
        Date.now().toString(),
      );
    }

    // Clean up expired referral codes (older than 30 days)
    const timestamp = readStorageItem(
      "sessionStorage",
      "referralCodeTimestamp",
    );
    if (timestamp) {
      const age = Date.now() - Number.parseInt(timestamp, 10);
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

      if (age > thirtyDaysMs) {
        removeStorageItem("sessionStorage", "referralCode");
        removeStorageItem("sessionStorage", "referralCodeTimestamp");
        logger.info(
          "Removed expired referral code",
          undefined,
          "ReferralCaptureProvider",
        );
      }
    }
  }, [searchParams]);

  // This component doesn't render anything
  return null;
}

/**
 * Get the stored referral code
 *
 * Call this function during signup/onboarding to retrieve the
 * referral code that was captured from the URL.
 */
export function getReferralCode(): string | null {
  return readStorageItem("sessionStorage", "referralCode");
}

/**
 * Clear the stored referral code
 *
 * Call this after successful signup to prevent reuse.
 */
export function clearReferralCode(): void {
  removeStorageItem("sessionStorage", "referralCode");
  removeStorageItem("sessionStorage", "referralCodeTimestamp");
}
