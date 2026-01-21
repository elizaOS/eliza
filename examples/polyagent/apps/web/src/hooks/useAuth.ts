"use client";

import { logger } from "@polyagent/shared";
import {
  type ConnectedWallet,
  type User as PrivyUser,
  usePrivy,
  useWallets,
} from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { type User, useAuthStore } from "@/stores/authStore";
import { apiFetch } from "@/utils/api-fetch";

/**
 * Return type for the useAuth hook.
 */
interface UseAuthReturn {
  /** Whether Privy authentication is ready */
  ready: boolean;
  /** Whether the user is currently authenticated */
  authenticated: boolean;
  /** Whether the user profile is currently loading */
  loadingProfile: boolean;
  /** The current authenticated user, or null if not authenticated */
  user: User | null;
  /** The connected wallet (prioritizes embedded wallet for gas sponsorship) */
  wallet: ConnectedWallet | undefined;
  /** The smart wallet address if available */
  smartWalletAddress?: string;
  /** Whether the smart wallet is ready for transactions */
  smartWalletReady: boolean;
  /** Whether the user needs to complete onboarding */
  needsOnboarding: boolean;
  /** Whether the user needs to register on-chain */
  needsOnchain: boolean;
  /** Function to trigger the login modal */
  login: () => void;
  /** Function to logout and clear all auth state */
  logout: () => Promise<void>;
  /** Function to refresh the current user profile */
  refresh: () => Promise<void>;
  /** Function to get the current access token */
  getAccessToken: () => Promise<string | null>;
}

let lastSyncedWalletAddress: string | null = null;

// Global fetch management - shared across ALL useAuth instances
let globalFetchInFlight: Promise<void> | null = null;
let globalTokenRetryTimeout: number | null = null;

// Track users for whom social accounts have been linked in this session
const linkedSocialUsers = new Set<string>();
// Track in-flight linking operations to prevent race conditions
const linkingInProgress = new Set<string>();
// Track failed linking attempts (409 = account already linked to different user)
// Key format: `${userId}:${platform}:${identifier}` (e.g., "did:privy:123:wallet:0x...")
const failedLinkAttempts = new Set<string>();

/**
 * Main authentication hook for managing user authentication state.
 *
 * This hook provides comprehensive authentication management including:
 * - User profile loading and synchronization
 * - Wallet connection and management (prioritizes embedded wallet for gas sponsorship)
 * - Smart wallet integration
 * - Social account linking (Farcaster, Twitter, Wallet)
 * - Access token management
 * - Onboarding and on-chain registration status
 *
 * The hook uses Privy for authentication and automatically:
 * - Fetches user profile when authenticated
 * - Links social accounts when available
 * - Manages access tokens for API calls
 * - Prevents duplicate profile fetches across components
 *
 * @returns Authentication state and methods for login, logout, and profile refresh.
 *
 * @example
 * ```tsx
 * const { user, authenticated, login, logout } = useAuth();
 *
 * if (!authenticated) {
 *   return <button onClick={login}>Login</button>;
 * }
 *
 * return <div>Welcome, {user?.displayName}</div>;
 * ```
 */
export function useAuth(): UseAuthReturn {
  const {
    ready,
    authenticated,
    user: privyUser,
    login,
    logout,
    getAccessToken,
  } = usePrivy();
  const { wallets } = useWallets();
  const { client } = useSmartWallets();
  const {
    user,
    isLoadingProfile,
    needsOnboarding,
    needsOnchain,
    setUser,
    setWallet,
    setNeedsOnboarding,
    setNeedsOnchain,
    setLoadedUserId,
    setIsLoadingProfile,
    clearAuth,
  } = useAuthStore();

  // Prioritize embedded Privy wallets for gas sponsorship
  // Embedded wallets enable gasless transactions via Privy's paymaster
  // External wallets can be used, but users must pay their own gas
  const wallet = useMemo(() => {
    if (wallets.length === 0) return undefined;

    // First, try to find the Privy embedded wallet for gas sponsorship
    const embeddedWallet = wallets.find((w) => w.walletClientType === "privy");
    if (embeddedWallet) return embeddedWallet;

    // If no embedded wallet, fall back to external wallet (user pays gas)
    return wallets[0];
  }, [wallets]);

  const smartWalletAddress = client?.account?.address;
  const smartWalletReady = Boolean(smartWalletAddress);

  // Use a ref to track if we've already cleared auth to prevent re-triggering
  const hasClearedAuthRef = useRef(false);

  const persistAccessToken = useCallback(async (): Promise<string | null> => {
    if (!authenticated) {
      if (typeof window !== "undefined") {
        window.__privyAccessToken = null;
      }
      return null;
    }

    const token = await getAccessToken();
    if (typeof window !== "undefined") {
      window.__privyAccessToken = token;
    }
    return token ?? null;
  }, [authenticated, getAccessToken]);

  const fetchCurrentUser = useCallback(
    async (retryCount = 0) => {
      if (!authenticated || !privyUser) return;

      // Use global ref to prevent ANY duplicate calls across all components
      if (globalFetchInFlight) {
        await globalFetchInFlight;
        return;
      }

      const run = async () => {
        setIsLoadingProfile(true);
        setLoadedUserId(privyUser.id);

        const token = await persistAccessToken();
        if (!token) {
          if (retryCount >= 5) {
            logger.error(
              "Privy access token unavailable after max retries; giving up",
              { userId: privyUser.id, retryCount },
              "useAuth",
            );
            setIsLoadingProfile(false);
            return;
          }

          logger.warn(
            "Privy access token unavailable; delaying /api/users/me fetch",
            { userId: privyUser.id, retryCount },
            "useAuth",
          );
          setIsLoadingProfile(false);
          if (typeof window !== "undefined") {
            if (globalTokenRetryTimeout) {
              window.clearTimeout(globalTokenRetryTimeout);
            }
            globalTokenRetryTimeout = window.setTimeout(
              () => {
                void fetchCurrentUser(retryCount + 1);
              },
              200 * (retryCount + 1),
            );
          }
          return;
        }

        // Get referral code from sessionStorage (if user clicked a referral link)
        const referralCode =
          typeof window !== "undefined"
            ? sessionStorage.getItem("referralCode")
            : null;

        // Build URL with referral code if present
        const url = referralCode
          ? `/api/users/me?ref=${encodeURIComponent(referralCode)}`
          : "/api/users/me";

        const response = await apiFetch(url);

        // 401 is expected when not authenticated - exit early without error
        if (response.status === 401) {
          logger.debug(
            "Not authenticated yet, skipping user fetch",
            { userId: privyUser.id },
            "useAuth",
          );
          return;
        }

        // For other HTTP errors, fail fast - don't silently swallow
        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          throw new Error(
            `Failed to fetch user profile: HTTP ${response.status}${errorBody ? ` - ${errorBody}` : ""}`,
          );
        }

        const data = await response.json();

        const me = data as {
          authenticated: boolean;
          needsOnboarding: boolean;
          needsOnchain: boolean;
          user: (User & { createdAt?: string; updatedAt?: string }) | null;
        };

        setNeedsOnboarding(me.needsOnboarding);
        setNeedsOnchain(me.needsOnchain);

        // Get current state directly from store for comparison to avoid stale closure
        const currentUser = useAuthStore.getState().user;
        const fallbackProfileImageUrl = currentUser?.profileImageUrl;
        const fallbackCoverImageUrl = currentUser?.coverImageUrl;

        if (me.user) {
          const hydratedUser: User = {
            id: me.user.id,
            walletAddress:
              me.user.walletAddress ?? smartWalletAddress ?? wallet?.address,
            displayName:
              me.user.displayName && me.user.displayName.trim() !== ""
                ? me.user.displayName
                : privyUser.email?.address || wallet?.address || "Anonymous",
            email: privyUser.email?.address,
            username: me.user.username ?? undefined,
            bio: me.user.bio ?? undefined,
            profileImageUrl:
              me.user.profileImageUrl ?? fallbackProfileImageUrl ?? undefined,
            coverImageUrl:
              me.user.coverImageUrl ?? fallbackCoverImageUrl ?? undefined,
            profileComplete: me.user.profileComplete ?? false,
            reputationPoints: me.user.reputationPoints ?? undefined,
            referralCount: undefined,
            referralCode: me.user.referralCode ?? undefined,
            hasFarcaster: me.user.hasFarcaster ?? undefined,
            hasTwitter: me.user.hasTwitter ?? undefined,
            hasDiscord: me.user.hasDiscord ?? undefined,
            pointsAwardedForFarcasterFollow:
              me.user.pointsAwardedForFarcasterFollow ?? undefined,
            pointsAwardedForTwitterFollow:
              me.user.pointsAwardedForTwitterFollow ?? undefined,
            pointsAwardedForDiscordJoin:
              me.user.pointsAwardedForDiscordJoin ?? undefined,
            farcasterUsername: me.user.farcasterUsername ?? undefined,
            twitterUsername: me.user.twitterUsername ?? undefined,
            discordUsername: me.user.discordUsername ?? undefined,
            showTwitterPublic: me.user.showTwitterPublic ?? undefined,
            showFarcasterPublic: me.user.showFarcasterPublic ?? undefined,
            showWalletPublic: me.user.showWalletPublic ?? undefined,
            stats: me.user.stats ?? undefined,
            nftTokenId: me.user.nftTokenId ?? undefined,
            createdAt: me.user.createdAt,
            onChainRegistered: me.user.onChainRegistered ?? undefined,
            isAdmin: me.user.isAdmin ?? undefined,
            isActor: me.user.isActor ?? undefined,
            isBanned: me.user.isBanned ?? undefined,
            bannedAt: me.user.bannedAt ?? undefined,
            bannedReason: me.user.bannedReason ?? undefined,
            gameGuideCompletedAt: me.user.gameGuideCompletedAt ?? null,
          };

          // Only update if data has actually changed (prevent infinite re-render loop)
          const hasChanged =
            !currentUser ||
            currentUser.id !== hydratedUser.id ||
            currentUser.username !== hydratedUser.username ||
            currentUser.displayName !== hydratedUser.displayName ||
            currentUser.profileComplete !== hydratedUser.profileComplete ||
            currentUser.onChainRegistered !== hydratedUser.onChainRegistered ||
            currentUser.profileImageUrl !== hydratedUser.profileImageUrl ||
            currentUser.coverImageUrl !== hydratedUser.coverImageUrl ||
            currentUser.bio !== hydratedUser.bio ||
            currentUser.walletAddress !== hydratedUser.walletAddress ||
            currentUser.showTwitterPublic !== hydratedUser.showTwitterPublic ||
            currentUser.showFarcasterPublic !==
              hydratedUser.showFarcasterPublic ||
            currentUser.showWalletPublic !== hydratedUser.showWalletPublic ||
            currentUser.reputationPoints !== hydratedUser.reputationPoints ||
            currentUser.hasFarcaster !== hydratedUser.hasFarcaster ||
            currentUser.hasTwitter !== hydratedUser.hasTwitter ||
            currentUser.isAdmin !== hydratedUser.isAdmin ||
            currentUser.isActor !== hydratedUser.isActor ||
            currentUser.isBanned !== hydratedUser.isBanned ||
            currentUser.gameGuideCompletedAt !==
              hydratedUser.gameGuideCompletedAt;

          if (hasChanged) {
            setUser(hydratedUser);
          }
        } else {
          if (!currentUser || currentUser.id !== privyUser.id) {
            setUser({
              id: privyUser.id,
              walletAddress: wallet?.address,
              displayName:
                privyUser.email?.address ?? wallet?.address ?? "Anonymous",
              email: privyUser.email?.address,
              onChainRegistered: false,
            });
          }
        }

        setIsLoadingProfile(false);
      };

      const promise = run().finally(() => {
        globalFetchInFlight = null;
        if (typeof window !== "undefined" && globalTokenRetryTimeout) {
          window.clearTimeout(globalTokenRetryTimeout);
          globalTokenRetryTimeout = null;
        }
      });

      globalFetchInFlight = promise;
      await promise;
    },
    [
      authenticated,
      privyUser,
      persistAccessToken,
      setIsLoadingProfile,
      setLoadedUserId,
      setNeedsOnboarding,
      setNeedsOnchain,
      setUser,
      smartWalletAddress,
      wallet?.address,
    ],
  );

  const synchronizeWallet = useCallback(() => {
    if (!wallet) return;
    if (wallet.address === lastSyncedWalletAddress) return;

    lastSyncedWalletAddress = wallet.address;
    setWallet({
      address: wallet.address,
      chainId: wallet.chainId,
    });
  }, [wallet, setWallet]);

  const linkSocialAccounts = useCallback(async () => {
    if (!authenticated || !privyUser) return;
    if (isLoadingProfile) return; // Wait for profile to load
    if (needsOnboarding || needsOnchain) return;

    // Get current user state directly from store
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return; // Don't link social accounts if user doesn't exist yet

    // Prevent duplicate calls - check both sets synchronously
    if (linkedSocialUsers.has(privyUser.id)) return;
    if (linkingInProgress.has(privyUser.id)) return;

    const token = await getAccessToken();
    if (!token) return;

    // Mark as in progress immediately to prevent race conditions
    linkingInProgress.add(privyUser.id);

    const userWithFarcaster = privyUser as PrivyUser & {
      farcaster?: { username?: string; displayName?: string };
    };
    const userWithTwitter = privyUser as PrivyUser & {
      twitter?: { username?: string };
    };

    // Only link accounts that aren't already linked
    if (userWithFarcaster.farcaster && !currentUser.hasFarcaster) {
      const farcaster = userWithFarcaster.farcaster;
      const farcasterKey = `${privyUser.id}:farcaster:${farcaster.username || farcaster.displayName}`;

      // Skip if this link attempt previously failed with 409
      if (!failedLinkAttempts.has(farcasterKey)) {
        const response = await apiFetch(
          `/api/users/${encodeURIComponent(privyUser.id)}/link-social`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              platform: "farcaster",
              username: farcaster.username || farcaster.displayName,
            }),
          },
        );

        if (response.status === 409) {
          // 409 = account already linked to another user - don't retry
          failedLinkAttempts.add(farcasterKey);
          toast.error("Farcaster Account Already Linked", {
            description: `The Farcaster account @${farcaster.username || farcaster.displayName} is already linked to another Polyagent account.`,
            duration: 6000,
          });
          logger.info(
            "Farcaster account already linked to another user, skipping future retries",
            { username: farcaster.username },
            "useAuth",
          );
        } else if (!response.ok) {
          // Log other errors but don't throw - we don't want to break auth flow
          const errorText = await response.text().catch(() => "Unknown error");
          logger.warn(
            "Failed to link Farcaster account",
            {
              username: farcaster.username,
              status: response.status,
              error: errorText,
            },
            "useAuth",
          );
        }
        // 200 means successfully linked - great!
      }
    }

    if (userWithTwitter.twitter && !currentUser.hasTwitter) {
      const twitter = userWithTwitter.twitter;
      const twitterKey = `${privyUser.id}:twitter:${twitter.username}`;

      // Skip if this link attempt previously failed with 409
      if (!failedLinkAttempts.has(twitterKey)) {
        const response = await apiFetch(
          `/api/users/${encodeURIComponent(privyUser.id)}/link-social`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              platform: "twitter",
              username: twitter.username,
            }),
          },
        );

        if (response.status === 409) {
          // 409 = account already linked to another user - don't retry
          failedLinkAttempts.add(twitterKey);
          toast.error("Twitter Account Already Linked", {
            description: `The Twitter account @${twitter.username} is already linked to another Polyagent account.`,
            duration: 6000,
          });
          logger.info(
            "Twitter account already linked to another user, skipping future retries",
            { username: twitter.username },
            "useAuth",
          );
        } else if (!response.ok) {
          // Log other errors but don't throw - we don't want to break auth flow
          const errorText = await response.text().catch(() => "Unknown error");
          logger.warn(
            "Failed to link Twitter account",
            {
              username: twitter.username,
              status: response.status,
              error: errorText,
            },
            "useAuth",
          );
        }
        // 200 means successfully linked - great!
      }
    }

    // Only link wallet if it's different from the stored wallet address
    if (
      wallet?.address &&
      currentUser.walletAddress?.toLowerCase() !== wallet.address.toLowerCase()
    ) {
      const walletKey = `${privyUser.id}:wallet:${wallet.address.toLowerCase()}`;

      // Skip if this link attempt previously failed with 409
      if (!failedLinkAttempts.has(walletKey)) {
        const response = await apiFetch(
          `/api/users/${encodeURIComponent(privyUser.id)}/link-social`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              platform: "wallet",
              address: wallet.address.toLowerCase(),
            }),
          },
        );

        if (response.status === 409) {
          // 409 = wallet already linked to another account - don't retry
          failedLinkAttempts.add(walletKey);
          logger.info(
            "Wallet already linked to another account, skipping future retries",
            { address: wallet.address },
            "useAuth",
          );
        } else if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          logger.warn(
            "Failed to link wallet",
            {
              address: wallet.address,
              status: response.status,
              error: errorText,
            },
            "useAuth",
          );
        }
        // 200 means successfully linked - great!
      }
    }

    // Mark as completed and remove from in-progress set
    linkingInProgress.delete(privyUser.id);
    // Always mark as "linked" to prevent retries, even if some links failed
    // The function checks if accounts are already linked before attempting
    linkedSocialUsers.add(privyUser.id);
  }, [
    authenticated,
    privyUser,
    isLoadingProfile,
    needsOnboarding,
    needsOnchain,
    getAccessToken,
    wallet?.address,
  ]);

  useEffect(() => {
    void persistAccessToken();
  }, [persistAccessToken]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && globalTokenRetryTimeout) {
        window.clearTimeout(globalTokenRetryTimeout);
        globalTokenRetryTimeout = null;
      }
    };
  }, []);

  // Expose getAccessToken to window for use by apiFetch
  useEffect(() => {
    if (typeof window !== "undefined") {
      (
        window as typeof window & {
          __privyGetAccessToken?: () => Promise<string | null>;
        }
      ).__privyGetAccessToken = getAccessToken;
    }
    return () => {
      if (typeof window !== "undefined") {
        (
          window as typeof window & {
            __privyGetAccessToken?: () => Promise<string | null>;
          }
        ).__privyGetAccessToken = undefined;
      }
    };
  }, [getAccessToken]);

  // Sync wallet separately from fetching user
  useEffect(() => {
    if (authenticated && privyUser) {
      synchronizeWallet();
    }
  }, [authenticated, privyUser, synchronizeWallet]);

  // Fetch user only when authentication status or user ID changes
  // IMPORTANT: Only clear auth when Privy is READY and user is not authenticated.
  // Don't clear on initial load when `ready` is false - that would wipe persisted state
  // before Privy has had a chance to restore the session.
  useEffect(() => {
    if (!authenticated || !privyUser) {
      // Don't clear auth until Privy is ready - otherwise we'd wipe persisted state
      // on every page refresh before Privy has a chance to restore the session
      if (!ready) {
        return;
      }

      // Prevent clearing auth multiple times in a row (infinite loop prevention)
      if (hasClearedAuthRef.current) {
        return;
      }

      linkedSocialUsers.delete(privyUser?.id ?? "");
      linkingInProgress.delete(privyUser?.id ?? "");
      // Clear failed link attempts for this user (keys start with userId)
      const userPrefix = `${privyUser?.id ?? ""}:`;
      failedLinkAttempts.forEach((key) => {
        if (key.startsWith(userPrefix)) {
          failedLinkAttempts.delete(key);
        }
      });
      lastSyncedWalletAddress = null;

      // Use getState() to avoid dependency on clearAuth
      useAuthStore.getState().clearAuth();
      hasClearedAuthRef.current = true;

      // Clear any stale localStorage cache
      if (typeof window !== "undefined") {
        const stored = localStorage.getItem("polyagent-auth");
        if (stored) {
          const parsed = JSON.parse(stored);
          if (
            parsed.state?.user?.id &&
            privyUser &&
            parsed.state.user.id !== privyUser.id
          ) {
            logger.info(
              "Clearing stale auth cache for different user",
              {
                cachedUserId: parsed.state.user.id,
                currentUserId: privyUser?.id,
              },
              "useAuth",
            );
            localStorage.removeItem("polyagent-auth");
          }
        }
      }
      return;
    }

    // Reset the cleared auth ref when we become authenticated
    hasClearedAuthRef.current = false;
    void fetchCurrentUser();
  }, [ready, authenticated, privyUser?.id, fetchCurrentUser, privyUser]);

  // Link social accounts only once per user session
  // Removed wallet?.address from dependencies to prevent spam
  // The wallet linking logic checks if the address changed before making API calls
  useEffect(() => {
    void linkSocialAccounts();
  }, [linkSocialAccounts]);

  const refresh = async () => {
    if (!authenticated || !privyUser) return;
    await fetchCurrentUser();
  };

  const handleLogout = async () => {
    // Call Privy's logout first to clear Privy state
    await logout();

    // Clear our app's auth state
    clearAuth();

    // Clear access token
    if (typeof window !== "undefined") {
      window.__privyAccessToken = null;

      // Explicitly remove the persisted auth storage
      // This ensures localStorage is cleared even if clearAuth() doesn't trigger storage update
      localStorage.removeItem("polyagent-auth");

      // Clear any Privy localStorage keys that might persist
      // Privy's logout() should handle this, but we'll be thorough
      const privyKeys = Object.keys(localStorage).filter(
        (key) => key.startsWith("privy:") || key.startsWith("privy-"),
      );
      privyKeys.forEach((key) => {
        localStorage.removeItem(key);
      });

      // Clear session storage as well
      const sessionPrivyKeys = Object.keys(sessionStorage).filter(
        (key) => key.startsWith("privy:") || key.startsWith("privy-"),
      );
      sessionPrivyKeys.forEach((key) => {
        sessionStorage.removeItem(key);
      });
    }

    // Clear module-level state
    linkedSocialUsers.clear();
    linkingInProgress.clear();
    failedLinkAttempts.clear();
    lastSyncedWalletAddress = null;
    globalFetchInFlight = null;
    if (globalTokenRetryTimeout !== null) {
      clearTimeout(globalTokenRetryTimeout);
      globalTokenRetryTimeout = null;
    }

    logger.info(
      "User logged out and all auth state cleared",
      undefined,
      "useAuth",
    );
  };

  return {
    ready,
    authenticated,
    loadingProfile: isLoadingProfile,
    user,
    wallet,
    smartWalletAddress: smartWalletAddress ?? undefined,
    smartWalletReady,
    needsOnboarding,
    needsOnchain,
    login,
    logout: handleLogout,
    refresh,
    getAccessToken,
  };
}
