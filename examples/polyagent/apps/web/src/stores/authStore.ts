/**
 * Authentication Store
 *
 * Manages user authentication state, wallet connection, and onboarding status.
 * Persists authentication data to localStorage for session persistence.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * User profile data structure.
 * Contains user information, authentication status, and preferences.
 */
export interface User {
  id: string;
  walletAddress?: string;
  displayName: string;
  email?: string;
  username?: string;
  bio?: string;
  profileImageUrl?: string;
  coverImageUrl?: string;
  profileComplete?: boolean;
  nftTokenId?: number | null;
  createdAt?: string;
  isActor?: boolean;
  isAdmin?: boolean;
  isBanned?: boolean;
  bannedAt?: string | null;
  bannedReason?: string | null;
  reputationPoints?: number;
  virtualBalance?: number;
  referralCount?: number;
  referralCode?: string;
  onChainRegistered?: boolean;
  hasFarcaster?: boolean;
  hasTwitter?: boolean;
  hasDiscord?: boolean;
  pointsAwardedForEmail?: boolean;
  pointsAwardedForFarcasterFollow?: boolean;
  pointsAwardedForTwitterFollow?: boolean;
  pointsAwardedForDiscordJoin?: boolean;
  farcasterUsername?: string;
  twitterUsername?: string;
  discordUsername?: string;
  showTwitterPublic?: boolean;
  showFarcasterPublic?: boolean;
  showWalletPublic?: boolean;
  bannerLastShown?: string;
  bannerDismissCount?: number;
  usernameChangedAt?: string | null;
  // Legal and compliance
  tosAccepted?: boolean;
  tosAcceptedAt?: string | null;
  tosAcceptedVersion?: string | null;
  privacyPolicyAccepted?: boolean;
  privacyPolicyAcceptedAt?: string | null;
  privacyPolicyAcceptedVersion?: string | null;
  stats?: {
    positions?: number;
    comments?: number;
    reactions?: number;
    followers?: number;
    following?: number;
  };
  // Game guide completion
  gameGuideCompletedAt?: string | null;
}

interface Wallet {
  address: string;
  chainId: string;
}

interface AuthState {
  user: User | null;
  wallet: Wallet | null;
  loadedUserId: string | null;
  isLoadingProfile: boolean;
  needsOnboarding: boolean;
  needsOnchain: boolean;
  setUser: (user: User) => void;
  setWallet: (wallet: Wallet) => void;
  setLoadedUserId: (userId: string) => void;
  setIsLoadingProfile: (loading: boolean) => void;
  setNeedsOnboarding: (needsOnboarding: boolean) => void;
  setNeedsOnchain: (needsOnchain: boolean) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      wallet: null,
      loadedUserId: null,
      isLoadingProfile: false,
      needsOnboarding: false,
      needsOnchain: false,
      setUser: (user) => set({ user }),
      setWallet: (wallet) => set({ wallet }),
      setLoadedUserId: (userId) => set({ loadedUserId: userId }),
      setIsLoadingProfile: (loading) => set({ isLoadingProfile: loading }),
      setNeedsOnboarding: (needsOnboarding) => set({ needsOnboarding }),
      setNeedsOnchain: (needsOnchain) => set({ needsOnchain }),
      clearAuth: () =>
        set({
          user: null,
          wallet: null,
          loadedUserId: null,
          isLoadingProfile: false,
          needsOnboarding: false,
          needsOnchain: false,
        }),
    }),
    {
      name: "polyagent-auth",
      version: 2, // Increment this to invalidate old cached data
    },
  ),
);
