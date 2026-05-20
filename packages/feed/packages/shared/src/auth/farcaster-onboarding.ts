/**
 * Farcaster Sign-In utilities for onboarding
 * Handles Farcaster protocol authentication flow and profile data fetching
 * Uses the proper Sign In with Farcaster (SIWF) protocol via relay.farcaster.xyz
 */

import { logger } from "../utils/logger";
import { signInWithFarcaster } from "./farcaster-auth-client";

export interface FarcasterOnboardingProfile {
  fid: number;
  username: string;
  displayName?: string;
  pfpUrl?: string;
  bio?: string;
}

/**
 * Open Farcaster Sign-In popup and handle authentication
 * Uses the proper SIWF protocol via relay.farcaster.xyz
 */
export async function openFarcasterOnboardingPopup(
  userId: string,
): Promise<FarcasterOnboardingProfile> {
  const result = await signInWithFarcaster({
    userId,
    onStatusUpdate: (state) => {
      logger.debug(
        "Farcaster auth status update",
        { state },
        "FarcasterOnboarding",
      );
    },
  });

  // Call the backend to verify and store the authentication
  const response = await fetch("/api/auth/onboarding/farcaster/callback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: result.message,
      signature: result.signature,
      fid: result.fid,
      username: result.username,
      displayName: result.displayName,
      pfpUrl: result.pfpUrl,
      bio: result.bio,
      state: result.state,
    }),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      errorData.error || "Failed to verify Farcaster authentication",
    );
  }

  return {
    fid: result.fid,
    username: result.username,
    displayName: result.displayName,
    pfpUrl: result.pfpUrl,
    bio: result.bio,
  };
}

/**
 * Alternative: Use Neynar's Farcaster auth widget (simpler integration)
 * Note: This now uses the same proper SIWF flow
 */
export async function openNeynarFarcasterAuth(
  userId: string,
): Promise<FarcasterOnboardingProfile> {
  return openFarcasterOnboardingPopup(userId);
}

/**
 * Fetch additional Farcaster profile data from Neynar API
 */
export async function fetchFarcasterProfile(
  fid: number,
): Promise<FarcasterOnboardingProfile | null> {
  const response = await fetch(`/api/farcaster/profile/${fid}`);

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    profile?: FarcasterOnboardingProfile;
  };
  return data.profile ?? null;
}
