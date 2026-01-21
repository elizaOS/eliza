/**
 * Profile Type Definitions
 *
 * Types for user and actor profiles used throughout the application
 */

import type { Actor } from "../game-types";

/**
 * User profile information
 */
export interface UserProfile {
  id: string;
  username?: string;
  bio?: string;
  avatar?: string;
  walletAddress?: string;
  email?: string;
  nftTokenId?: number;
  onChainRegistered?: boolean;
  virtualBalance?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/**
 * Actor profile information (extended from Actor)
 */
export interface ActorProfile extends Actor {
  postCount?: number;
  followerCount?: number;
  followingCount?: number;
  recentPosts?: Array<{
    id: string;
    content: string;
    timestamp: string;
  }>;
}

/**
 * Combined profile type (user or actor)
 * Includes all properties that may be present in profile pages
 */
export type ProfileInfo = (UserProfile | ActorProfile) & {
  type?: "user" | "actor" | "organization";
  role?: string;
  name?: string;
  username?: string;
  description?: string;
  profileDescription?: string;
  tier?: string;
  domain?: string[];
  personality?: string;
  affiliations?: string[];
  game?: { id: string };
  isUser?: boolean;
  profileImageUrl?: string;
  coverImageUrl?: string;
  onChainRegistered?: boolean;
  nftTokenId?: number | null;
  stats?: {
    posts?: number;
    followers?: number;
    following?: number;
  };
};

/**
 * Type guard to check if profile is a user profile
 */
export function isUserProfile(profile: ProfileInfo): profile is UserProfile {
  return (
    "username" in profile || "email" in profile || "walletAddress" in profile
  );
}

/**
 * Type guard to check if profile is an actor profile
 */
export function isActorProfile(profile: ProfileInfo): profile is ActorProfile {
  return "description" in profile && "domain" in profile;
}
