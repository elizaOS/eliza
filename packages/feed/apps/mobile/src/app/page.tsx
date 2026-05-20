"use client";

import { HomePageClient } from "@web/app/HomePageClient";

/**
 * Mobile home page — renders HomePageClient directly.
 * Skips the web version's host detection, waitlist check, and NFT gating.
 */
export default function MobileHomePage() {
  return <HomePageClient />;
}
