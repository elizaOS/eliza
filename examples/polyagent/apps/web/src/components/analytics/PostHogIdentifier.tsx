"use client";

/**
 * PostHog identifier component for identifying users to PostHog analytics.
 *
 * Automatically identifies authenticated users to PostHog with their user
 * properties. Resets identification on logout. Tracks user profile information
 * and authentication status.
 *
 * Features:
 * - User identification
 * - Property tracking
 * - Logout reset
 * - Profile data tracking
 *
 * @returns null (does not render anything)
 */
import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { posthog } from "@/lib/posthog";

export function PostHogIdentifier() {
  const { user, authenticated } = useAuth();
  const identifiedUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!posthog || typeof window === "undefined") return;

    // Identify user when authenticated
    if (authenticated && user?.id && user.id !== identifiedUserId.current) {
      const properties: Record<string, string | number | boolean | null> = {
        hasProfileImage: Boolean(user.profileImageUrl),
        hasBio: Boolean(user.bio),
        profileComplete: user.profileComplete ?? false,
        onChainRegistered: user.onChainRegistered ?? false,
        hasFarcaster: user.hasFarcaster ?? false,
        hasTwitter: user.hasTwitter ?? false,
        authenticated: true,
      };

      if (user.username) {
        properties.username = user.username;
      }
      if (user.displayName) {
        properties.displayName = user.displayName;
      }
      if (user.walletAddress) {
        properties.walletAddress = user.walletAddress;
      }
      if (user.farcasterUsername) {
        properties.farcasterUsername = user.farcasterUsername;
      }
      if (user.twitterUsername) {
        properties.twitterUsername = user.twitterUsername;
      }
      if (user.reputationPoints !== undefined) {
        properties.reputationPoints = user.reputationPoints;
      }
      if (user.createdAt) {
        properties.createdAt = user.createdAt;
      }

      posthog.identify(user.id, properties);
      identifiedUserId.current = user.id;

      // Set user properties (people API is optional and may not exist)
      const posthogWithPeople = posthog as typeof posthog & {
        people?: {
          set: (properties: Record<string, string | boolean>) => void;
        };
      };
      if (
        posthogWithPeople.people &&
        typeof posthogWithPeople.people.set === "function"
      ) {
        const peopleProperties: Record<string, string | boolean> = {
          authenticated: true,
        };
        if (user.username) {
          peopleProperties.username = user.username;
        }
        if (user.displayName) {
          peopleProperties.displayName = user.displayName;
        }
        posthogWithPeople.people.set(peopleProperties);
      }
    }

    // Reset on logout
    if (!authenticated && identifiedUserId.current) {
      posthog.reset();
      identifiedUserId.current = null;
    }
  }, [authenticated, user]);

  return null;
}
