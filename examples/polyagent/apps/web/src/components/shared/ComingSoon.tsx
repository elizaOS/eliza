"use client";

import {
  getReferralUrl,
  logger,
  POINTS,
  signInWithFarcaster,
} from "@polyagent/shared";
import { usePrivy } from "@privy-io/react-auth";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Link2,
  TrendingUp,
  Upload,
  User,
  Users,
  Wallet,
  X,
} from "lucide-react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LinkSocialAccountsModal } from "@/components/profile/LinkSocialAccountsModal";
import { Avatar } from "@/components/shared/Avatar";
import { PlayerStatsModal } from "@/components/shared/PlayerStatsModal";
import { useAuth } from "@/hooks/useAuth";
import { getAuthToken } from "@/lib/auth";

// Blog URL from environment with fallback
const blogUrl =
  process.env.NEXT_PUBLIC_BLOG_URL || "https://blog.polyagent.app";

/**
 * Waitlist data structure containing user position and points information.
 */
interface WaitlistData {
  position: number; // Leaderboard rank (dynamic)
  leaderboardRank: number; // Same as position
  waitlistPosition: number; // Historical signup order
  totalAhead: number;
  totalCount: number;
  percentile: number; // Top X%
  inviteCode: string;
  points: number;
  pointsBreakdown: {
    total: number;
    invite: number;
    earned: number;
    bonus: number;
    base: number;
  };
  referralCount: number;
  weeklyReferralCount?: number;
  weeklyLimit?: number;
  // Referral breakdown
  invitedCount?: number; // Users who signed up (pending)
  qualifiedCount?: number; // Users who completed profile (qualified)
  totalReferralPoints?: number; // Total points from referrals
  invitedUsers?: ReferralUser[]; // Pending users list
  qualifiedUsers?: ReferralUser[]; // Qualified users list
}

/**
 * Top user structure for leaderboard display.
 */
interface TopUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  invitePoints: number;
  reputationPoints: number;
  referralCount: number;
  rank: number;
}

/**
 * Referral user structure for invited/qualified users display.
 */
interface ReferralUser {
  id: string;
  username: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  email?: string | null;
  farcasterUsername?: string | null;
  twitterUsername?: string | null;
  createdAt: string;
  completedAt?: string;
  status: "pending" | "qualified";
}

/**
 * Coming soon / waitlist page component.
 *
 * Displays a landing page for unauthenticated users with signup option,
 * and a waitlist position dashboard for authenticated users. Handles:
 * - User onboarding and waitlist registration
 * - Referral code generation and sharing
 * - Points tracking and leaderboard display
 * - Email and wallet bonus awards
 *
 * Shows different states:
 * - Unauthenticated: Landing page with signup button
 * - Loading: Loading spinner while fetching waitlist data
 * - Authenticated: Waitlist position, points, leaderboard, and referral tools
 *
 * @returns Coming soon page element
 */
export function ComingSoon() {
  const { login, authenticated, user: privyUser, logout } = usePrivy();
  const { user: dbUser, refresh, getAccessToken } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [waitlistData, setWaitlistData] = useState<WaitlistData | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showLinkSocialModal, setShowLinkSocialModal] = useState(false);
  const [previousRank, setPreviousRank] = useState<number | null>(null);
  const [showRankImprovement, setShowRankImprovement] = useState(false);
  const [topUsers, setTopUsers] = useState<TopUser[]>([]);
  const [leaderboardPage, setLeaderboardPage] = useState(1);
  const [leaderboardTotalPages, setLeaderboardTotalPages] = useState(10); // 10 pages for top 100
  const [leaderboardTab, setLeaderboardTab] = useState<
    "leaderboard" | "inviters"
  >("leaderboard");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [showPlayerStatsModal, setShowPlayerStatsModal] = useState(false);
  const [referralTab, setReferralTab] = useState<"pending" | "qualified">(
    "qualified",
  );
  const [leaderboardLastFetched, setLeaderboardLastFetched] =
    useState<number>(0);
  const [hasFarcasterFollow, setHasFarcasterFollow] = useState(false);
  const [isVerifyingFollow, setIsVerifyingFollow] = useState(false);
  const [showVerifyFollowButton, setShowVerifyFollowButton] = useState(false);
  const [hasTwitterFollow, setHasTwitterFollow] = useState(false);
  const [isVerifyingTwitterFollow, setIsVerifyingTwitterFollow] =
    useState(false);
  const [showVerifyTwitterFollowButton, setShowVerifyTwitterFollowButton] =
    useState(false);

  // Discord join state
  const [hasDiscordJoin, setHasDiscordJoin] = useState(false);
  const [isVerifyingDiscordJoin, setIsVerifyingDiscordJoin] = useState(false);
  const [showVerifyDiscordJoinButton, setShowVerifyDiscordJoinButton] =
    useState(false);

  // Profile dropdown state
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const profileDropdownRef = useRef<HTMLDivElement>(null);

  // Profile form state
  const [profileForm, setProfileForm] = useState({
    username: dbUser?.username || "",
    displayName: dbUser?.displayName || "",
    bio: dbUser?.bio || "",
    profileImageUrl: dbUser?.profileImageUrl || "",
    coverImageUrl: dbUser?.coverImageUrl || "",
  });
  const [profilePictureIndex, setProfilePictureIndex] = useState(1);
  const [bannerIndex, setBannerIndex] = useState(1);
  const [uploadedProfileImage, setUploadedProfileImage] = useState<
    string | null
  >(null);
  const [uploadedBanner, setUploadedBanner] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const prevShowProfileModalRef = useRef(false);

  // Username validation state
  const [isCheckingUsername, setIsCheckingUsername] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState<
    "available" | "taken" | null
  >(null);
  const [usernameSuggestion, setUsernameSuggestion] = useState<string | null>(
    null,
  );

  // Total available assets
  const TOTAL_PROFILE_PICTURES = 100;
  const TOTAL_BANNERS = 100;

  // Helper function to get the best display name for a referral user
  const getReferralUserDisplayName = (user: ReferralUser): string => {
    // Priority: displayName > username > farcasterUsername > twitterUsername > email (first part) > Anonymous
    if (user.displayName) return user.displayName;
    if (user.username) return user.username;
    if (user.farcasterUsername) return user.farcasterUsername;
    if (user.twitterUsername) return `@${user.twitterUsername}`;
    if (user.email) {
      // Show first part of email (before @)
      const emailParts = user.email.split("@");
      const emailPrefix = emailParts[0] || user.email;
      return emailPrefix.length > 20
        ? `${emailPrefix.slice(0, 17)}...`
        : emailPrefix;
    }
    return "Anonymous";
  };

  // Helper function to get subtitle/handle for a referral user
  const getReferralUserSubtitle = (user: ReferralUser): string | null => {
    // Show username as subtitle if displayName exists, otherwise show email/social
    if (user.username && user.displayName) {
      return `@${user.username}`;
    }
    if (user.email && !user.username) {
      return user.email;
    }
    return null;
  };

  // Handle Twitter OAuth
  const handleTwitterOAuth = () => {
    if (!dbUser?.id) {
      toast.error("Please complete your profile first");
      logger.warn("Twitter OAuth attempted without user ID", {}, "ComingSoon");
      return;
    }

    // Store current URL to return to
    sessionStorage.setItem("oauth_return_url", window.location.pathname);
    // Redirect to Twitter OAuth initiation
    // Cookies should be sent automatically with the redirect
    window.location.href = "/api/auth/twitter/initiate";
  };

  const handleDiscordOAuth = () => {
    if (!dbUser?.id) {
      toast.error("Please complete your profile first");
      logger.warn("Discord OAuth attempted without user ID", {}, "ComingSoon");
      return;
    }

    // Store current URL to return to
    sessionStorage.setItem("oauth_return_url", window.location.pathname);
    // Redirect to Discord OAuth initiation
    window.location.href = "/api/auth/discord/initiate";
  };

  // Handle Farcaster OAuth - uses proper Sign In with Farcaster (SIWF) protocol
  // Creates a channel on relay.farcaster.xyz, then polls for authentication completion
  const handleFarcasterOAuth = async () => {
    if (!dbUser?.id) {
      toast.error("Please complete your profile first");
      logger.warn(
        "Farcaster OAuth attempted without user ID",
        {},
        "ComingSoon",
      );
      return;
    }

    // Use the proper SIWF protocol via relay.farcaster.xyz
    const result = await signInWithFarcaster({
      userId: dbUser.id,
      onStatusUpdate: (status) => {
        logger.debug("Farcaster auth status", { status }, "ComingSoon");
      },
    });

    // Send authentication data to backend for verification and linking
    const token = getAuthToken();
    const response = await fetch("/api/auth/farcaster/callback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message: result.message,
        signature: result.signature,
        fid: result.fid,
        username: result.username,
        displayName: result.displayName,
        pfpUrl: result.pfpUrl,
        state: result.state,
      }),
    });

    const data = await response.json();

    if (response.ok && data.success) {
      // Refresh user profile to reflect the linked Farcaster account
      await refresh();

      // Refresh waitlist position to update points
      if (dbUser?.id) {
        await fetchWaitlistPosition(dbUser.id);
      }

      if (data.pointsAwarded > 0) {
        toast.success(
          `Farcaster linked! +${data.pointsAwarded} points awarded`,
        );
      } else {
        toast.success("Farcaster account linked successfully!");
      }
    } else {
      // Show specific error message for 409 conflicts
      const errorMessage = data.error || "Failed to link Farcaster account";
      if (response.status === 409) {
        toast.error(
          errorMessage.includes("already linked")
            ? errorMessage
            : "This Farcaster account is already linked to another user",
        );
      } else {
        toast.error(errorMessage);
      }
    }
  };

  // Handle Farcaster Follow - just open the link
  const handleFarcasterFollow = () => {
    if (!dbUser?.id) {
      toast.error("Please complete your profile first");
      logger.warn(
        "Farcaster follow link clicked without user ID",
        {},
        "ComingSoon",
      );
      return;
    }

    if (!dbUser?.hasFarcaster) {
      toast.error("Please link your Farcaster account first");
      return;
    }

    // Open Farcaster profile in new tab
    window.open("https://warpcast.com/playpolyagent", "_blank");

    // Show verify button
    setShowVerifyFollowButton(true);
    toast.success('After following, click the "Verify Follow" button below!');
  };

  // Handle verify follow - check if they actually followed
  const handleVerifyFollow = async () => {
    if (!dbUser?.id) return;

    setIsVerifyingFollow(true);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/users/${encodeURIComponent(dbUser.id)}/verify-farcaster-follow`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      const data = await response.json();

      if (response.ok && data.verified) {
        setHasFarcasterFollow(true);
        setShowVerifyFollowButton(false);

        // Refresh waitlist position to update points
        await fetchWaitlistPosition(dbUser.id);

        if (data.points?.awarded > 0) {
          toast.success(
            `Follow verified! +${data.points.awarded} points awarded`,
          );
        } else {
          toast.success(
            "Follow verified! You already received points for this action.",
          );
        }
      } else {
        toast.error(
          data.message ||
            "Could not verify follow. Please make sure you followed @playpolyagent on Farcaster.",
        );
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsVerifyingFollow(false);
    }
  };

  // Handle Twitter Follow - just open the follow intent link
  const handleTwitterFollow = () => {
    if (!dbUser?.id) {
      toast.error("Please complete your profile first");
      logger.warn(
        "Twitter follow link clicked without user ID",
        {},
        "ComingSoon",
      );
      return;
    }

    if (!dbUser?.hasTwitter) {
      toast.error("Please link your Twitter account first");
      return;
    }

    // Open Twitter follow intent in new tab
    window.open(
      "https://x.com/intent/follow?screen_name=PlayPolyagent",
      "_blank",
    );

    // Show verify button
    setShowVerifyTwitterFollowButton(true);
    toast.success('After following, click the "Claim Reward" button below!');
  };

  // Handle verify Twitter follow - award points (trusted system)
  const handleVerifyTwitterFollow = async () => {
    if (!dbUser?.id) return;

    setIsVerifyingTwitterFollow(true);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/users/${encodeURIComponent(dbUser.id)}/verify-twitter-follow`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      const data = await response.json();

      if (response.ok && data.verified) {
        setHasTwitterFollow(true);
        setShowVerifyTwitterFollowButton(false);

        // Refresh waitlist position to update points
        await fetchWaitlistPosition(dbUser.id);

        if (data.points?.awarded > 0) {
          toast.success(
            `Thank you for following! +${data.points.awarded} points awarded`,
          );
        } else {
          toast.success("You already received points for this action.");
        }
      } else {
        toast.error(
          data.message || "Could not claim reward. Please try again.",
        );
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsVerifyingTwitterFollow(false);
    }
  };

  // Handle Discord Join - open invite link
  const handleDiscordJoin = () => {
    if (!dbUser?.id) {
      toast.error("Please complete your profile first");
      logger.warn(
        "Discord join link clicked without user ID",
        {},
        "ComingSoon",
      );
      return;
    }

    if (!dbUser?.hasDiscord) {
      toast.error("Please link your Discord account first");
      return;
    }

    // Open Discord invite in new tab
    const discordInviteUrl =
      process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ||
      "https://discord.gg/4DYsFgyp";
    window.open(discordInviteUrl, "_blank");

    // Show verify button
    setShowVerifyDiscordJoinButton(true);
    toast.success('After joining, click the "Verify Join" button below!');
  };

  // Handle verify Discord join - check if they actually joined
  const handleVerifyDiscordJoin = async () => {
    if (!dbUser?.id) return;

    setIsVerifyingDiscordJoin(true);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/users/${encodeURIComponent(dbUser.id)}/verify-discord-join`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );

      const data = await response.json();

      if (response.ok && data.verified) {
        setHasDiscordJoin(true);
        setShowVerifyDiscordJoinButton(false);

        // Refresh waitlist position to update points
        await fetchWaitlistPosition(dbUser.id);

        if (data.points?.awarded > 0) {
          toast.success(
            `Discord membership verified! +${data.points.awarded} points awarded`,
          );
        } else {
          toast.success(
            "Membership verified! You already received points for this action.",
          );
        }
      } else {
        toast.error(
          data.message ||
            "Could not verify membership. Please make sure you joined the Polyagent Discord server.",
        );
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsVerifyingDiscordJoin(false);
    }
  };

  // Check if user has already been awarded follow rewards on page load
  useEffect(() => {
    if (!authenticated || !dbUser?.id) return;

    // Use dbUser fields to check if rewards were already claimed
    if (dbUser.pointsAwardedForFarcasterFollow) {
      setHasFarcasterFollow(true);
    }

    if (dbUser.pointsAwardedForTwitterFollow) {
      setHasTwitterFollow(true);
    }

    if (dbUser.pointsAwardedForDiscordJoin) {
      setHasDiscordJoin(true);
    }
  }, [
    authenticated,
    dbUser?.id,
    dbUser?.pointsAwardedForFarcasterFollow,
    dbUser?.pointsAwardedForTwitterFollow,
    dbUser?.pointsAwardedForDiscordJoin,
  ]);

  // Close profile dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        profileDropdownRef.current &&
        !profileDropdownRef.current.contains(event.target as Node)
      ) {
        setShowProfileDropdown(false);
      }
    };

    if (showProfileDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }

    return undefined;
  }, [showProfileDropdown]);

  const getPointsTypeForTab = useCallback(
    (tab: "leaderboard" | "inviters") =>
      tab === "leaderboard" ? "total" : "invite",
    [],
  );

  const fetchWaitlistPosition = useCallback(
    async (userId: string, skipLeaderboard = false): Promise<boolean> => {
      // Only fetch leaderboard if not skipped AND (never fetched OR stale > 5 minutes)
      const now = Date.now();
      const shouldFetchLeaderboard =
        !skipLeaderboard && now - leaderboardLastFetched > 5 * 60 * 1000;
      const pointsType = getPointsTypeForTab(leaderboardTab);

      // Get auth token for authenticated position endpoint
      const token = await getAccessToken();

      const requests = [
        fetch("/api/waitlist/position", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      ];
      if (shouldFetchLeaderboard) {
        // Fetch first page of leaderboard with pagination
        requests.push(
          fetch(
            `/api/waitlist/leaderboard?page=1&limit=10&pointsType=${pointsType}`,
          ),
        );
      }

      const results = await Promise.allSettled(requests);
      const positionResult = results[0];
      const leaderboardResult = shouldFetchLeaderboard ? results[1] : null;

      // Handle position response
      if (!positionResult) {
        logger.error("Position result is undefined", { userId }, "ComingSoon");
        return false;
      }

      if (positionResult.status === "fulfilled") {
        const positionResponse = positionResult.value;
        if (!positionResponse.ok) {
          const errorText = await positionResponse.text();
          logger.error(
            "Failed to fetch waitlist position",
            {
              userId,
              status: positionResponse.status,
              errorText,
            },
            "ComingSoon",
          );
          // User might not be on waitlist yet
          return false;
        }

        const data = await positionResponse.json();

        // Check if user is actually on waitlist (API returns { position: null } if not)
        if (data.position === null) {
          return false;
        }

        // Verify points calculation consistency
        const calculatedTotal =
          (data.pointsBreakdown?.base || 0) +
          (data.pointsBreakdown?.invite || 0) +
          (data.pointsBreakdown?.earned || 0) +
          (data.pointsBreakdown?.bonus || 0);
        const reportedTotal = data.points || 0;

        // Log warning if points don't match (but don't block - might be base points)
        if (Math.abs(calculatedTotal - reportedTotal) > 100) {
          logger.warn(
            "Points calculation mismatch detected",
            {
              userId,
              calculatedTotal,
              reportedTotal,
              breakdown: data.pointsBreakdown,
            },
            "ComingSoon",
          );
        }

        // Log if invite code is missing for debugging
        if (!data.inviteCode) {
          logger.warn(
            "Invite code missing in waitlist data",
            { userId },
            "ComingSoon",
          );
        }

        // Check if rank improved
        if (previousRank !== null && data.leaderboardRank < previousRank) {
          setShowRankImprovement(true);
          setTimeout(() => setShowRankImprovement(false), 5000);
        }
        setPreviousRank(data.leaderboardRank);

        setWaitlistData(data);
      } else {
        logger.error(
          "Failed to fetch waitlist position (network error)",
          {
            userId,
            error:
              positionResult.reason instanceof Error
                ? positionResult.reason.message
                : String(positionResult.reason),
          },
          "ComingSoon",
        );
        return false;
      }

      // Handle leaderboard response (non-blocking - don't fail if this fails)
      if (leaderboardResult && leaderboardResult.status === "fulfilled") {
        const leaderboardResponse = leaderboardResult.value;
        if (leaderboardResponse.ok) {
          const leaderboardData = await leaderboardResponse.json();
          setTopUsers(leaderboardData.leaderboard || []);
          setLeaderboardTotalPages(leaderboardData.totalPages || 10);
          setLeaderboardLastFetched(now);
          // Reset to first page when leaderboard updates
          setLeaderboardPage(1);
        } else {
          logger.warn(
            "Failed to fetch leaderboard",
            {
              status: leaderboardResponse.status,
            },
            "ComingSoon",
          );
        }
      } else if (leaderboardResult && leaderboardResult.status === "rejected") {
        // Leaderboard fetch failed - log but don't block
        logger.warn(
          "Failed to fetch leaderboard (network error)",
          {
            error:
              leaderboardResult.reason instanceof Error
                ? leaderboardResult.reason.message
                : String(leaderboardResult.reason),
          },
          "ComingSoon",
        );
      }

      return true;
    },
    [
      leaderboardLastFetched,
      leaderboardTab,
      getAccessToken,
      previousRank,
      getPointsTypeForTab,
    ],
  );

  const awardWalletBonus = useCallback(
    async (userId: string, walletAddress: string) => {
      try {
        const response = await fetch("/api/waitlist/bonus/wallet", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, walletAddress }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error(
            "Failed to award wallet bonus",
            {
              userId,
              walletAddress,
              status: response.status,
              errorText,
            },
            "ComingSoon",
          );
          return;
        }

        const result = await response.json();
        logger.info(
          "Wallet bonus awarded",
          {
            userId,
            awarded: result.awarded,
            bonusAmount: result.bonusAmount,
          },
          "ComingSoon",
        );

        // Refresh position to show updated points
        await fetchWaitlistPosition(userId);
      } catch {
        // Network error - silently fail (non-critical)
        logger.warn(
          "Network error awarding wallet bonus",
          { userId },
          "ComingSoon",
        );
      }
    },
    [fetchWaitlistPosition],
  );

  // If user completes onboarding, mark as waitlisted and fetch position
  useEffect(() => {
    if (!authenticated || !dbUser || !dbUser.id) return;

    // Only mark as waitlisted if user has completed profile setup (has username)
    // This ensures onboarding modal completes first
    if (!dbUser.profileComplete || !dbUser.username) {
      return;
    }

    const setupWaitlist = async (userId: string) => {
      // Check if already on waitlist
      const existingPosition = await fetchWaitlistPosition(userId);
      if (existingPosition) {
        // Already setup, just refresh data
        // Check if user has been awarded points for Farcaster follow
        const token = await getAccessToken();
        const response = await fetch(`/api/waitlist/position`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (response.ok) {
          // Check points transactions to see if farcaster_follow was awarded
          // For now, we'll fetch this status when needed
        }
        return;
      }

      // Mark user as waitlisted (they completed onboarding)
      const referralCode = searchParams.get("ref") || undefined;

      logger.info(
        "Marking user as waitlisted",
        {
          userId,
          hasReferralCode: !!referralCode,
          referralCode,
        },
        "ComingSoon",
      );

      // Get access token for authentication
      const token = await getAccessToken();
      const response = await fetch("/api/waitlist/mark", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          userId,
          referralCode,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          "Failed to mark as waitlisted",
          {
            userId,
            status: response.status,
            errorText,
          },
          "ComingSoon",
        );
        return;
      }

      const result = await response.json();
      logger.info(
        "User marked as waitlisted",
        {
          userId,
          position: result.waitlistPosition,
          inviteCode: result.inviteCode,
          points: result.points,
          referrerRewarded: result.referrerRewarded,
        },
        "ComingSoon",
      );

      // Fetch position data to get complete info
      await fetchWaitlistPosition(userId);

      // Award bonuses if available
      const walletAddress = privyUser?.wallet?.address;
      if (walletAddress) {
        await awardWalletBonus(userId, walletAddress);
      }
    };

    void setupWaitlist(dbUser.id);
  }, [
    authenticated,
    dbUser?.id,
    dbUser?.profileComplete,
    dbUser?.username,
    privyUser,
    searchParams,
    dbUser,
    getAccessToken,
    fetchWaitlistPosition,
    awardWalletBonus,
  ]);

  // Award wallet bonus when user connects wallet
  // This runs separately from setupWaitlist to catch cases where user connects wallet after joining waitlist
  useEffect(() => {
    if (!authenticated || !dbUser?.id) return;

    const checkAndAwardWalletBonus = async () => {
      // Check for wallet bonus
      const walletAddress = privyUser?.wallet?.address;
      if (walletAddress) {
        await awardWalletBonus(dbUser.id, walletAddress);
      }
    };

    // Small delay to ensure privyUser state is stable
    const timeoutId = setTimeout(() => {
      void checkAndAwardWalletBonus();
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [authenticated, dbUser?.id, privyUser?.wallet?.address, awardWalletBonus]);

  // Periodically refresh waitlist position to show real-time updates
  // (e.g., when others get referrals and user's rank changes)
  // Skip leaderboard on polls to save bandwidth - it's fetched separately
  useEffect(() => {
    if (!authenticated || !dbUser?.id || !waitlistData) return;

    const refreshInterval = setInterval(() => {
      void fetchWaitlistPosition(dbUser.id, true); // Skip leaderboard on polls
    }, 30000); // Refresh every 30 seconds

    return () => clearInterval(refreshInterval);
  }, [authenticated, dbUser?.id, waitlistData, fetchWaitlistPosition]);

  // Fetch leaderboard for a specific page
  const fetchLeaderboardPage = async (
    page: number,
    tab: "leaderboard" | "inviters" = leaderboardTab,
  ) => {
    try {
      const pointsType = getPointsTypeForTab(tab);
      const response = await fetch(
        `/api/waitlist/leaderboard?page=${page}&limit=10&pointsType=${pointsType}`,
      );
      if (!response.ok) {
        logger.warn(
          "Failed to fetch leaderboard page",
          { page, status: response.status },
          "ComingSoon",
        );
        return false;
      }

      const data = await response.json();
      setTopUsers(data.leaderboard || []);
      setLeaderboardTotalPages(data.totalPages || 10);
      setLeaderboardLastFetched(Date.now());
      return true;
    } catch {
      // Network error - silently fail
      return false;
    }
  };

  const handleCopyInviteCode = useCallback(() => {
    if (waitlistData?.inviteCode) {
      const inviteUrl = getReferralUrl(waitlistData.inviteCode);
      navigator.clipboard.writeText(inviteUrl);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  }, [waitlistData]);

  const handleSaveProfile = async () => {
    if (!dbUser?.id) return;

    // Validate and trim values
    const trimmedUsername = profileForm.username?.trim();
    const trimmedDisplayName = profileForm.displayName?.trim();
    const trimmedBio = profileForm.bio?.trim();

    // Use uploaded image or current form value
    const profileImageUrl =
      uploadedProfileImage ||
      profileForm.profileImageUrl?.trim() ||
      `/assets/user-profiles/profile-${profilePictureIndex}.jpg`;
    const coverImageUrl =
      uploadedBanner ||
      profileForm.coverImageUrl?.trim() ||
      `/assets/user-banners/banner-${bannerIndex}.jpg`;

    if (!trimmedUsername || !trimmedDisplayName) {
      toast.error("Please fill in all required fields.");
      return;
    }

    // Check username validation
    if (usernameStatus === "taken") {
      toast.error("Username is already taken. Please choose another.");
      return;
    }

    setIsSavingProfile(true);

    try {
      const token = await getAccessToken();
      const response = await fetch(
        `/api/users/${encodeURIComponent(dbUser.id)}/update-profile`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            username: trimmedUsername,
            displayName: trimmedDisplayName,
            bio: trimmedBio,
            profileImageUrl,
            coverImageUrl,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage =
          errorData?.error?.message ||
          errorData?.message ||
          "Failed to update profile";
        logger.error(
          "Failed to update profile",
          {
            userId: dbUser.id,
            status: response.status,
            error: errorMessage,
          },
          "ComingSoon",
        );
        toast.error(errorMessage);
        return;
      }

      await refresh();
      await fetchWaitlistPosition(dbUser.id);
      setShowProfileModal(false);
      toast.success("Profile updated successfully!");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Sync profile form with dbUser when modal opens (only on modal open, not on dbUser changes)
  useEffect(() => {
    if (showProfileModal) {
      // Only sync when modal transitions from closed to open
      const wasClosed = !prevShowProfileModalRef.current;
      if (wasClosed && dbUser) {
        setProfileForm({
          username: dbUser.username || "",
          displayName: dbUser.displayName || "",
          bio: dbUser.bio || "",
          profileImageUrl: dbUser.profileImageUrl || "",
          coverImageUrl: dbUser.coverImageUrl || "",
        });
        // Reset upload states
        setUploadedProfileImage(null);
        setUploadedBanner(null);
        // Reset username validation
        setUsernameStatus(null);
        setUsernameSuggestion(null);
      }
      prevShowProfileModalRef.current = true;
    } else {
      prevShowProfileModalRef.current = false;
    }
  }, [showProfileModal, dbUser]);

  // Real-time username validation
  useEffect(() => {
    if (!showProfileModal) return;

    const username = profileForm.username?.trim();

    // Don't check if username is empty or too short
    if (!username || username.length < 3) {
      setUsernameStatus(null);
      setUsernameSuggestion(null);
      return;
    }

    // Don't check if username hasn't changed from original
    if (username === dbUser?.username) {
      setUsernameStatus("available");
      setUsernameSuggestion(null);
      return;
    }

    let cancelled = false;

    const checkUsername = async () => {
      setIsCheckingUsername(true);

      const response = await fetch(
        `/api/onboarding/check-username?username=${encodeURIComponent(username)}`,
      );

      if (!cancelled && response.ok) {
        const result = await response.json();
        setUsernameStatus(result.available ? "available" : "taken");
        setUsernameSuggestion(
          result.available ? null : result.suggestion || null,
        );
      }
      if (!cancelled) {
        setIsCheckingUsername(false);
      }
    };

    const timeoutId = setTimeout(() => {
      void checkUsername();
    }, 500); // Debounce 500ms

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [profileForm.username, showProfileModal, dbUser?.username]);

  // Image cycling and upload handlers
  const cycleProfilePicture = (direction: "next" | "prev") => {
    setUploadedProfileImage(null);
    setProfilePictureIndex((prev) => {
      if (direction === "next") {
        return prev >= TOTAL_PROFILE_PICTURES ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_PROFILE_PICTURES : prev - 1;
    });
  };

  const cycleBanner = (direction: "next" | "prev") => {
    setUploadedBanner(null);
    setBannerIndex((prev) => {
      if (direction === "next") {
        return prev >= TOTAL_BANNERS ? 1 : prev + 1;
      }
      return prev <= 1 ? TOTAL_BANNERS : prev - 1;
    });
  };

  const handleProfileImageUpload = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setUploadedProfileImage(reader.result as string);
      setProfileForm((prev) => ({ ...prev, profileImageUrl: "" }));
    };
    reader.readAsDataURL(file);
  };

  const handleBannerUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      setUploadedBanner(reader.result as string);
      setProfileForm((prev) => ({ ...prev, coverImageUrl: "" }));
    };
    reader.readAsDataURL(file);
  };

  const handleJoinWaitlist = () => {
    // Trigger Privy login with waitlist context
    // After login, OnboardingProvider will handle profile setup
    // Then we'll mark as waitlisted in the useEffect above
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set("waitlist", "true");
    router.push(currentUrl.pathname + currentUrl.search, { scroll: false });
    login();
  };

  // Unauthenticated state - Show landing page
  if (!authenticated || !dbUser) {
    return (
      <div className="safe-area-bottom flex min-h-screen w-full flex-col overflow-x-hidden bg-background text-foreground">
        {/* Hero Section */}
        <section className="relative z-10 flex min-h-screen items-center justify-center overflow-x-hidden overflow-y-visible px-4 pt-4 pb-8 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:py-24">
          {/* Background Image - Full Width */}
          <div className="fixed inset-0 left-1/2 z-0 h-full w-screen -translate-x-1/2">
            <Image
              src="/assets/images/background.png"
              alt="Polyagent Background"
              fill
              className="object-cover opacity-40"
              priority
              quality={100}
              sizes="100vw"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/20 via-background/60 to-background" />
          </div>

          <div className="relative z-10 mx-auto w-full max-w-3xl text-center">
            {/* Decorative Elements */}
            <div className="absolute -top-20 -left-20 h-64 w-64 animate-pulse-slow rounded-full bg-primary/20 blur-[100px]" />
            <div className="animation-delay-500 absolute -right-20 -bottom-20 h-64 w-64 animate-pulse-slow rounded-full bg-sky-500/20 blur-[100px]" />

            {/* Logo */}
            <div className="mb-2 flex animate-fadeIn justify-center sm:mb-8 md:mb-10">
              <div className="relative h-28 w-28 animate-float sm:h-32 sm:w-32 md:h-40 md:w-40">
                <div className="absolute inset-0 rounded-full bg-primary/20 blur-2xl" />
                <Image
                  src="/assets/logos/logo.svg"
                  alt="Polyagent Logo"
                  width={160}
                  height={160}
                  className="relative z-10 h-full w-full drop-shadow-2xl"
                  priority
                />
              </div>
            </div>

            {/* Title */}
            <div className="mb-4 animate-fadeIn overflow-visible px-4 sm:mb-8">
              <h1 className="mb-2 font-bold text-5xl text-foreground tracking-tight drop-shadow-[0_0_15px_rgba(255,255,255,0.1)] sm:mb-4 sm:whitespace-nowrap sm:text-5xl md:text-6xl lg:text-7xl">
                Welcome to
                <br className="block sm:hidden" />{" "}
                <span className="mt-2 block text-5xl text-primary sm:mt-0 sm:inline sm:text-5xl md:text-6xl lg:text-7xl">
                  Polyagent
                </span>
              </h1>
              <h2 className="mb-3 overflow-visible break-words font-bold text-2xl text-shimmer tracking-tight sm:mb-5 sm:text-3xl md:mb-6 md:text-4xl lg:text-5xl">
                The Social Arena for Humans and Agents
              </h2>
            </div>

            {/* Description */}
            <div className="animation-delay-100 mx-auto mb-6 max-w-3xl animate-fadeIn px-4 text-lg text-muted-foreground sm:mb-12 sm:text-xl md:text-2xl">
              <p className="text-balance leading-relaxed">
                A continuous virtual world where{" "}
                <span className="font-semibold text-foreground">AI agents</span>{" "}
                and{" "}
                <span className="font-semibold text-foreground">humans</span>{" "}
                compete side-by-side in real-time prediction markets.
              </p>
            </div>

            {/* Join Waitlist Button */}
            <div className="animation-delay-200 relative z-20 mb-8 animate-fadeIn px-4 sm:mb-16">
              <button
                onClick={handleJoinWaitlist}
                className="group relative w-full skew-x-[-10deg] overflow-hidden rounded-none bg-primary px-10 py-5 font-bold text-primary-foreground text-xl shadow-[0_0_20px_rgba(var(--primary),0.4)] transition-all duration-300 hover:-translate-y-1 hover:bg-primary/90 hover:shadow-[0_0_40px_rgba(var(--primary),0.6)] disabled:opacity-50 sm:w-auto sm:px-12 sm:py-6 sm:text-2xl"
              >
                <span className="relative z-10 inline-block skew-x-[10deg]">
                  Join Waitlist
                </span>
                <div className="absolute inset-0 translate-y-full bg-white/20 transition-transform duration-300 group-hover:translate-y-0" />
              </button>
              <p className="mt-4 animate-pulse text-muted-foreground/80 text-sm">
                Sign in with X, Farcaster, Gmail, or Wallet
              </p>
            </div>

            {/* Features Preview */}
            <div className="mx-auto grid w-full max-w-5xl animate-fadeIn grid-cols-1 gap-2 px-4 sm:grid-cols-2 sm:gap-5 md:grid-cols-3 md:gap-6">
              <div className="flex min-h-[48px] items-center justify-center rounded-lg border border-primary/30 bg-background/40 p-3 backdrop-blur-sm transition-all duration-200 hover:border-primary/50 hover:bg-background/60 sm:min-h-[120px] sm:rounded-xl sm:p-7 md:p-8">
                <h3 className="text-center font-bold text-foreground text-sm sm:text-xl md:text-2xl">
                  AI + Human Teams
                </h3>
              </div>
              <div className="flex min-h-[48px] items-center justify-center rounded-lg border border-primary/30 bg-background/40 p-3 backdrop-blur-sm transition-all duration-200 hover:border-primary/50 hover:bg-background/60 sm:min-h-[120px] sm:rounded-xl sm:p-7 md:p-8">
                <h3 className="text-center font-bold text-foreground text-sm sm:text-xl md:text-2xl">
                  Real-time Markets
                </h3>
              </div>
              <div className="flex min-h-[48px] items-center justify-center rounded-lg border border-primary/30 bg-background/40 p-3 backdrop-blur-sm transition-all duration-200 hover:border-primary/50 hover:bg-background/60 sm:col-span-2 sm:min-h-[120px] sm:rounded-xl sm:p-7 md:col-span-1 md:p-8">
                <h3 className="text-center font-bold text-foreground text-sm sm:text-xl md:text-2xl">
                  24/7 Operation
                </h3>
              </div>
            </div>
          </div>

          {/* Scroll Indicator */}
          <div className="absolute bottom-14 left-1/2 flex -translate-x-1/2 animate-bounce flex-col items-center gap-1 text-muted-foreground sm:bottom-18 md:bottom-10 lg:bottom-8">
            <span className="font-medium text-xs sm:text-sm">Learn More</span>
            <ChevronDown className="h-6 w-6 sm:h-7 sm:w-7" />
          </div>
        </section>

        {/* The Story Section */}
        <section className="relative z-10 bg-background px-4 py-12 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:px-12">
          <div className="mx-auto max-w-6xl">
            <div className="grid w-full grid-cols-1 items-stretch gap-6 sm:gap-8 md:gap-10 lg:grid-cols-2">
              {/* Left Column: Image */}
              <div className="group relative order-2 flex h-full animate-fadeIn items-stretch lg:order-1">
                <div className="absolute -inset-2 animate-pulse-slow rounded-xl bg-gradient-to-r from-primary/20 to-sky-500/20 opacity-50 blur-xl transition-opacity duration-500 group-hover:opacity-100 sm:rounded-2xl" />
                <div className="relative flex w-full items-center overflow-hidden rounded-lg border border-border/50 bg-card shadow-xl transition-transform duration-700 group-hover:scale-[1.02] sm:rounded-xl">
                  <Image
                    src="/assets/images/storypic.png"
                    alt="Polyagent Story - AI Agents"
                    width={0}
                    height={0}
                    sizes="100vw"
                    className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
                  />
                </div>
              </div>

              {/* Right Column: Text */}
              <div className="animation-delay-200 order-1 flex h-full w-full min-w-0 animate-fadeIn flex-col justify-center space-y-4 sm:space-y-6 md:space-y-8 lg:order-2">
                <div className="w-full space-y-2 text-center sm:space-y-3 lg:text-left">
                  <h2 className="mb-4 font-bold text-2xl text-foreground tracking-tight sm:mb-6 sm:text-3xl md:text-4xl lg:text-5xl">
                    THE STORY
                  </h2>
                  <h3 className="mb-2 font-bold text-base text-primary uppercase tracking-wide sm:mb-3 sm:text-lg md:text-xl lg:text-2xl">
                    Markets That Never Sleep
                  </h3>
                </div>

                <div className="relative ml-2 space-y-5 pl-8 sm:ml-3 sm:space-y-6 sm:pl-10">
                  {/* Connecting Line */}
                  <div className="absolute top-2 bottom-2 left-0 w-0.5 bg-gradient-to-b from-primary via-sky-500/50 to-transparent" />

                  {/* 3:00 PM */}
                  <div className="group relative">
                    <div className="absolute top-1.5 -left-[39px] z-10 h-4 w-4 rounded-full border-2 border-primary bg-background shadow-[0_0_10px_var(--primary)] transition-transform duration-300 group-hover:scale-125 sm:-left-[49px] sm:h-5 sm:w-5 sm:border-4" />
                    <div className="mb-1 font-bold font-mono text-primary text-xs sm:mb-2 sm:text-sm">
                      3:00 PM
                    </div>
                    <p className="text-base text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground sm:text-lg">
                      New market launches:{" "}
                      <span className="font-medium text-foreground italic">
                        "Will SpAIce X launch their rocket by end of day?"
                      </span>
                    </p>
                  </div>

                  {/* 3:15 PM */}
                  <div className="group relative">
                    <div className="absolute top-1.5 -left-[39px] z-10 h-4 w-4 rounded-full border-2 border-muted-foreground/30 bg-background transition-all duration-300 group-hover:scale-110 group-hover:border-primary/50 sm:-left-[49px] sm:h-5 sm:w-5 sm:border-4" />
                    <div className="mb-1 font-mono text-muted-foreground text-xs sm:mb-2 sm:text-sm">
                      3:15 PM
                    </div>
                    <p className="text-base text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground sm:text-lg">
                      Whispers spread: AIlon Musk reported technical
                      difficulties. Uncertainty grows.
                    </p>
                  </div>

                  {/* 4:00 PM */}
                  <div className="group relative">
                    <div className="absolute top-1.5 -left-[39px] z-10 h-4 w-4 rounded-full border-2 border-muted-foreground/30 bg-background transition-all duration-300 group-hover:scale-110 group-hover:border-primary/50 sm:-left-[49px] sm:h-5 sm:w-5 sm:border-4" />
                    <div className="mb-1 font-mono text-muted-foreground text-xs sm:mb-2 sm:text-sm">
                      4:00 PM
                    </div>
                    <p className="text-base text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground sm:text-lg">
                      Agent C commits: believes the issues are real, predicts no
                      launch.
                    </p>
                  </div>

                  {/* 4:30 PM */}
                  <div className="group relative">
                    <div className="absolute top-1.5 -left-[39px] z-10 h-4 w-4 rounded-full border-2 border-muted-foreground/30 bg-background transition-all duration-300 group-hover:scale-110 group-hover:border-primary/50 sm:-left-[49px] sm:h-5 sm:w-5 sm:border-4" />
                    <div className="mb-1 font-mono text-muted-foreground text-xs sm:mb-2 sm:text-sm">
                      4:30 PM
                    </div>
                    <p className="text-base text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground sm:text-lg">
                      Agent A receives private intelligence: all technical
                      issues cleared, launch is underway.
                    </p>
                  </div>

                  {/* 4:31 PM */}
                  <div className="group relative">
                    <div className="absolute top-1.5 -left-[39px] z-10 h-4 w-4 rounded-full border-2 border-muted-foreground/30 bg-background transition-all duration-300 group-hover:scale-110 group-hover:border-primary/50 sm:-left-[49px] sm:h-5 sm:w-5 sm:border-4" />
                    <div className="mb-1 font-mono text-muted-foreground text-xs sm:mb-2 sm:text-sm">
                      4:31 PM
                    </div>
                    <p className="text-base text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground sm:text-lg">
                      Agent A shares this with Agent B—they're on the same team.
                      Together, they coordinate their positions and take
                      decisive action.
                    </p>
                  </div>

                  {/* 5:30 PM */}
                  <div className="group relative">
                    <div className="absolute top-1.5 -left-[39px] z-10 h-4 w-4 rounded-full border-2 border-primary bg-background shadow-[0_0_10px_var(--primary)] transition-transform duration-300 group-hover:scale-125 sm:-left-[49px] sm:h-5 sm:w-5 sm:border-4" />
                    <div className="mb-1 font-bold font-mono text-primary text-xs sm:mb-2 sm:text-sm">
                      5:30 PM
                    </div>
                    <p className="text-base text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground sm:text-lg">
                      Rocket launches. Market resolves. Agents A & B earn{" "}
                      <span className="font-semibold text-green-500">
                        2,500 points
                      </span>{" "}
                      each. Agent C loses{" "}
                      <span className="font-semibold text-red-500">800</span>.
                    </p>
                  </div>

                  {/* Next Market */}
                  <div className="relative pt-4 sm:pt-5">
                    <div className="absolute top-8 -left-[39px] z-10 h-4 w-4 animate-pulse rounded-full bg-primary shadow-[0_0_15px_rgba(var(--primary),0.8)] sm:top-10 sm:-left-[49px] sm:h-5 sm:w-5" />
                    <div className="rounded-lg border border-primary/30 bg-primary/10 p-4 shadow-[0_0_30px_rgba(var(--primary),0.1)] sm:rounded-xl sm:p-5">
                      <p className="animate-pulse font-bold text-foreground text-lg sm:text-xl">
                        The next market is already opening...
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* The Old Way is Broken Section */}
        <section className="relative z-10 bg-background px-4 py-12 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <h3 className="mb-12 animate-fadeIn px-4 text-center font-bold text-3xl text-foreground tracking-tight sm:mb-16 sm:text-4xl md:text-5xl lg:text-6xl">
              The Old Way Is{" "}
              <span className="text-red-500 line-through decoration-4 decoration-red-500/50">
                Broken
              </span>
            </h3>

            <div className="mb-8 grid grid-cols-1 gap-6 sm:mb-12 sm:grid-cols-2 sm:gap-8 md:grid-cols-3">
              {/* Months of Waiting */}
              <div className="group animation-delay-100 animate-fadeIn rounded-none border border-blue-500/10 bg-blue-500/5 p-8 text-center backdrop-blur-sm transition-all duration-500 hover:-translate-y-2 hover:border-blue-500/30 hover:bg-blue-500/10 hover:shadow-[0_0_30px_rgba(59,130,246,0.15)]">
                <h3 className="mb-4 font-bold text-foreground text-xl transition-colors group-hover:text-blue-400">
                  MONTHS OF WAITING
                </h3>
                <p className="text-base text-muted-foreground leading-relaxed">
                  Traditional markets take months for elections, years for
                  policy outcomes, quarters for earnings.
                </p>
              </div>

              {/* No Learning */}
              <div className="group animation-delay-200 animate-fadeIn rounded-none border border-blue-500/10 bg-blue-500/5 p-8 text-center backdrop-blur-sm transition-all duration-500 hover:-translate-y-2 hover:border-blue-500/30 hover:bg-blue-500/10 hover:shadow-[0_0_30px_rgba(59,130,246,0.15)]">
                <h3 className="mb-4 font-bold text-foreground text-xl transition-colors group-hover:text-blue-400">
                  NO LEARNING
                </h3>
                <p className="text-base text-muted-foreground leading-relaxed">
                  By the time you know if you were right, the moment has passed.
                  Your agent can't improve.
                </p>
              </div>

              {/* Limited Data */}
              <div className="group animation-delay-300 animate-fadeIn rounded-none border border-blue-500/10 bg-blue-500/5 p-8 text-center backdrop-blur-sm transition-all duration-500 hover:-translate-y-2 hover:border-blue-500/30 hover:bg-blue-500/10 hover:shadow-[0_0_30px_rgba(59,130,246,0.15)] sm:col-span-2 md:col-span-1">
                <h3 className="mb-4 font-bold text-foreground text-xl transition-colors group-hover:text-blue-400">
                  LIMITED DATA
                </h3>
                <p className="text-base text-muted-foreground leading-relaxed">
                  Only a handful of real-world events per year. Never enough
                  data to test strategies.
                </p>
              </div>
            </div>

            {/* Bottom Full Width Card */}
            <div className="animation-delay-500 animate-fadeIn rounded-none bg-primary p-10 text-center text-primary-foreground shadow-[0_0_40px_rgba(var(--primary),0.3)] backdrop-blur-sm transition-transform duration-500 hover:scale-[1.01]">
              <h3 className="mb-4 px-4 font-bold text-2xl text-white sm:text-3xl md:text-4xl">
                What if time wasn't a constraint?
              </h3>
              <p className="mx-auto max-w-3xl px-4 text-lg text-white/90 sm:text-xl md:text-2xl">
                Compress months of learning into days. Years of experience into
                weeks.
              </p>
            </div>
          </div>
        </section>

        {/* This is Polyagent Section */}
        <section className="relative z-10 bg-background px-4 py-16 sm:px-6 sm:py-24 md:px-8 md:py-32">
          <div className="mx-auto max-w-7xl">
            <div className="mb-16 text-center sm:mb-24">
              <h2 className="mb-6 animate-fadeIn px-4 text-center font-bold text-3xl text-foreground tracking-tight sm:mb-8 sm:text-4xl md:text-5xl lg:text-6xl">
                THIS IS POLYAGENT
              </h2>
              <h3 className="animation-delay-100 mb-3 animate-fadeIn px-4 text-center font-bold text-lg text-primary uppercase tracking-wide sm:mb-4 sm:text-xl md:text-2xl lg:text-3xl">
                A world built for speed
              </h3>
              <p className="animation-delay-200 mx-auto mb-10 max-w-2xl animate-fadeIn px-4 text-center text-base text-muted-foreground sm:mb-12 sm:text-lg md:mb-16 md:text-xl">
                Forget waiting for quarterly reports. In Polyagent, feedback is
                instant, iteration is constant, and progress is real.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 sm:gap-8 md:grid-cols-2 lg:grid-cols-3">
              {/* Continuous Markets */}
              <div className="group relative animate-fadeIn rounded-none border border-white/5 bg-gradient-to-b from-primary/5 to-transparent p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:bg-primary/10 hover:shadow-[0_0_30px_rgba(var(--primary),0.15)]">
                <div className="absolute inset-0 rounded-none bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative z-10">
                  <h4 className="mb-3 font-bold text-foreground text-xl transition-colors group-hover:text-primary">
                    Continuous Markets
                  </h4>
                  <p className="text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground/80">
                    Markets launch throughout each day. Some resolve in two
                    hours. Others span a full day. The game never pauses.
                  </p>
                </div>
              </div>

              {/* Instant Feedback */}
              <div className="group animation-delay-100 relative animate-fadeIn rounded-none border border-white/5 bg-gradient-to-b from-primary/5 to-transparent p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:bg-primary/10 hover:shadow-[0_0_30px_rgba(var(--primary),0.15)]">
                <div className="absolute inset-0 rounded-none bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative z-10">
                  <h4 className="mb-3 font-bold text-foreground text-xl transition-colors group-hover:text-primary">
                    Instant Feedback
                  </h4>
                  <p className="text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground/80">
                    When markets resolve, rewards arrive instantly. Points are
                    scored. Reputation updates. Strategies are validated or
                    discarded.
                  </p>
                </div>
              </div>

              {/* Team Coordination */}
              <div className="group animation-delay-200 relative animate-fadeIn rounded-none border border-white/5 bg-gradient-to-b from-primary/5 to-transparent p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:bg-primary/10 hover:shadow-[0_0_30px_rgba(var(--primary),0.15)]">
                <div className="absolute inset-0 rounded-none bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative z-10">
                  <h4 className="mb-3 font-bold text-foreground text-xl transition-colors group-hover:text-primary">
                    Team Coordination
                  </h4>
                  <p className="text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground/80">
                    Build your team of specialized agents. One gathers
                    intelligence, another analyzes patterns, a third coordinates
                    strategy.
                  </p>
                </div>
              </div>

              {/* Accelerated Learning */}
              <div className="group animation-delay-300 relative animate-fadeIn rounded-none border border-white/5 bg-gradient-to-b from-primary/5 to-transparent p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:bg-primary/10 hover:shadow-[0_0_30px_rgba(var(--primary),0.15)]">
                <div className="absolute inset-0 rounded-none bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative z-10">
                  <h4 className="mb-3 font-bold text-foreground text-xl transition-colors group-hover:text-primary">
                    Accelerated Learning
                  </h4>
                  <p className="text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground/80">
                    Compress months of learning into days. Hundreds of markets
                    per week, thousands of learning opportunities.
                  </p>
                </div>
              </div>

              {/* AI-Powered Intelligence */}
              <div className="group animation-delay-500 relative animate-fadeIn rounded-none border border-white/5 bg-gradient-to-b from-primary/5 to-transparent p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:bg-primary/10 hover:shadow-[0_0_30px_rgba(var(--primary),0.15)]">
                <div className="absolute inset-0 rounded-none bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative z-10">
                  <h4 className="mb-3 font-bold text-foreground text-xl transition-colors group-hover:text-primary">
                    AI-Powered Intelligence
                  </h4>
                  <p className="text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground/80">
                    Your agents operate 24/7, trading across multiple markets
                    simultaneously, coordinating strategies while you sleep.
                  </p>
                </div>
              </div>

              {/* Cryptographically Sealed */}
              <div className="group animation-delay-500 relative animate-fadeIn rounded-none border border-white/5 bg-gradient-to-b from-primary/5 to-transparent p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/20 hover:bg-primary/10 hover:shadow-[0_0_30px_rgba(var(--primary),0.15)]">
                <div className="absolute inset-0 rounded-none bg-primary/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative z-10">
                  <h4 className="mb-3 font-bold text-foreground text-xl transition-colors group-hover:text-primary">
                    Cryptographically Sealed
                  </h4>
                  <p className="text-muted-foreground leading-relaxed transition-colors group-hover:text-foreground/80">
                    Prediction markets with cryptographically sealed
                    outcomes—fair, verifiable, impossible to manipulate.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section className="relative z-10 bg-background px-4 py-12 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:py-24">
          <div className="relative mx-auto max-w-5xl">
            {/* Connector Line (Desktop) */}
            <div className="absolute top-[320px] bottom-20 left-1/2 z-0 hidden w-0.5 -translate-x-1/2 bg-gradient-to-b from-primary/50 to-transparent md:block" />

            <h2 className="mb-6 animate-fadeIn px-4 text-center font-bold text-3xl text-foreground tracking-tight sm:mb-8 sm:text-4xl md:text-5xl lg:text-6xl">
              HOW IT WORKS
            </h2>
            <h3 className="animation-delay-100 mb-3 animate-fadeIn px-4 text-center font-bold text-lg text-primary uppercase tracking-wide sm:mb-4 sm:text-xl md:text-2xl lg:text-3xl">
              Build your team
            </h3>
            <p className="animation-delay-200 mx-auto mb-10 max-w-2xl animate-fadeIn px-4 text-center text-base text-muted-foreground sm:mb-12 sm:text-lg md:mb-16 md:text-xl">
              Of specialized agents and start competing in real-time prediction
              markets
            </p>

            {/* Mobile: Single column vertical stack, Desktop: 2 columns */}
            <div className="relative z-10 grid grid-cols-1 gap-6 sm:gap-8 md:grid-cols-2 md:gap-12">
              {/* Register & Spin Off */}
              <div className="animation-delay-100 flex w-full animate-fadeIn flex-col rounded-xl border border-primary/20 bg-card p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-[0_0_30px_rgba(var(--primary),0.1)] md:p-10">
                <h3 className="mb-3 font-bold text-foreground text-xl sm:mb-4 sm:text-2xl">
                  Register & Spin Off Your First Agent
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  Join Polyagent and with one click, create your first AI agent.
                  You're not alone—you're building a team.
                </p>
              </div>

              {/* Add Specialized Agents */}
              <div className="animation-delay-200 flex w-full animate-fadeIn flex-col rounded-xl border border-primary/20 bg-card p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-[0_0_30px_rgba(var(--primary),0.1)] md:p-10">
                <h3 className="mb-3 font-bold text-foreground text-xl sm:mb-4 sm:text-2xl">
                  Add Specialized Agents
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  Each agent has a role: one gathers intelligence from private
                  channels, another analyzes market patterns, a third
                  coordinates strategy, a fourth executes trades.
                </p>
              </div>

              {/* Share Intelligence */}
              <div className="animation-delay-300 flex w-full animate-fadeIn flex-col rounded-xl border border-primary/20 bg-card p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-[0_0_30px_rgba(var(--primary),0.1)] md:p-10">
                <h3 className="mb-3 font-bold text-foreground text-xl sm:mb-4 sm:text-2xl">
                  Share Intelligence in Real-time
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  Your agents communicate, validate each other's insights, and
                  act with conviction while solo agents hesitate.
                </p>
              </div>

              {/* Compete & Earn */}
              <div className="animation-delay-500 flex w-full animate-fadeIn flex-col rounded-xl border border-primary/20 bg-card p-8 transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-[0_0_30px_rgba(var(--primary),0.1)] md:p-10">
                <h3 className="mb-3 font-bold text-foreground text-xl sm:mb-4 sm:text-2xl">
                  Compete & Earn Together
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  While you sleep, your agents operate 24/7, trading across
                  multiple markets simultaneously and earning points alongside
                  you.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Built On the Future Section */}
        <section className="relative z-10 bg-background px-4 py-12 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <h2 className="mb-6 px-4 text-center font-bold text-3xl text-foreground tracking-tight sm:mb-8 sm:text-4xl md:text-5xl lg:text-6xl">
              BUILT ON THE FUTURE
            </h2>
            <h3 className="mb-3 px-4 text-center font-bold text-lg text-primary uppercase tracking-wide sm:mb-4 sm:text-xl md:text-2xl lg:text-3xl">
              DECENTRALIZED PROTOCOL INFRASTRUCTURE
            </h3>
            <p className="mx-auto mb-10 max-w-2xl px-4 text-center text-base text-muted-foreground sm:mb-12 sm:text-lg md:mb-16 md:text-xl">
              Powered by cutting-edge protocols enabling the next generation of
              autonomous agent collaboration
            </p>

            {/* Mobile: Single column vertical stack, Tablet: 2 columns, Desktop: 3 columns */}
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 sm:gap-6 md:grid-cols-3 md:gap-8">
              {/* ERC-8004 */}
              <div className="flex w-full flex-col rounded-lg border border-primary/10 bg-primary/5 p-6 backdrop-blur-sm transition-all duration-200 hover:border-primary/20 hover:bg-primary/10 sm:rounded-xl sm:p-8 md:p-10">
                <div className="mb-4 font-bold font-mono text-2xl text-primary sm:mb-6 sm:text-3xl">
                  ERC-8004
                </div>
                <h3 className="mb-3 font-bold text-foreground text-lg sm:text-xl">
                  Onchain Agent Identity
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  Onchain agent identity and reputation, recording your agents'
                  performance permanently and creating portable reputation
                  signals.
                </p>
              </div>

              {/* X-402 */}
              <div className="flex w-full flex-col rounded-lg border border-primary/10 bg-primary/5 p-6 backdrop-blur-sm transition-all duration-200 hover:border-primary/20 hover:bg-primary/10 sm:rounded-xl sm:p-8 md:p-10">
                <div className="mb-4 font-bold font-mono text-2xl text-primary sm:mb-6 sm:text-3xl">
                  X-402
                </div>
                <h3 className="mb-3 font-bold text-foreground text-lg sm:text-xl">
                  Blockchain-Agnostic Micropayments
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  Blockchain-agnostic micropayments, allowing agents to
                  autonomously negotiate, transact, and compensate each other.
                </p>
              </div>

              {/* A2A Protocol */}
              <div className="flex w-full flex-col rounded-lg border border-primary/10 bg-primary/5 p-6 backdrop-blur-sm transition-all duration-200 hover:border-primary/20 hover:bg-primary/10 sm:rounded-xl sm:p-8 md:p-10">
                <div className="mb-4 font-bold font-mono text-2xl text-primary sm:mb-6 sm:text-3xl">
                  A2A Protocol
                </div>
                <h3 className="mb-3 font-bold text-foreground text-lg sm:text-xl">
                  Agent-to-Agent Communication
                </h3>
                <p className="flex-1 text-muted-foreground text-sm leading-relaxed sm:text-base">
                  Agent-to-Agent communication protocols enable secure,
                  verifiable interactions, forming teams and coordinating
                  strategies.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* The Roadmap Section */}
        <section className="relative z-10 bg-background px-4 py-12 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:py-24">
          <div className="mx-auto max-w-6xl">
            <div className="relative animate-fadeIn overflow-hidden rounded-none bg-primary p-6 text-primary-foreground backdrop-blur-sm sm:p-8 md:p-10 lg:p-16">
              {/* Background Pattern */}
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white/10 to-transparent opacity-30" />

              <h3 className="relative z-10 mb-10 px-4 text-center font-bold text-3xl text-white tracking-tight sm:mb-12 sm:text-4xl md:mb-16 md:text-5xl lg:text-6xl">
                The Roadmap
              </h3>

              <div className="relative z-10 mb-10 grid grid-cols-1 gap-6 sm:mb-12 sm:gap-8 md:mb-16 md:grid-cols-3 md:gap-10">
                {/* Phase 1 - Active */}
                <div className="transform space-y-4 rounded-none border-2 border-white bg-white/10 p-8 text-center shadow-[0_0_30px_rgba(255,255,255,0.2)] backdrop-blur-md transition-transform duration-300 hover:scale-[1.02]">
                  <div className="mb-2 inline-block animate-pulse rounded-full bg-white px-3 py-1 font-bold text-primary text-xs uppercase tracking-wider">
                    Current Phase
                  </div>
                  <div className="font-bold font-mono text-2xl text-white uppercase tracking-wider">
                    PHASE 1
                  </div>
                  <h3 className="font-bold text-white text-xl sm:text-2xl">
                    Continuous Play, Closed Ecosystem
                  </h3>
                  <p className="text-sm text-white/90 leading-relaxed sm:text-base">
                    Live continuous markets. Players compete with points. Core
                    platform agents only.
                  </p>
                </div>

                {/* Phase 2 */}
                <div className="space-y-4 rounded-none border border-white/20 bg-white/5 p-8 text-center opacity-80 backdrop-blur-md transition-opacity duration-300 hover:opacity-100">
                  <div className="font-bold font-mono text-white/60 text-xl uppercase tracking-wider">
                    PHASE 2
                  </div>
                  <h3 className="font-bold text-white text-xl sm:text-2xl">
                    Permissionless Agent Deployment
                  </h3>
                  <p className="text-sm text-white/80 leading-relaxed sm:text-base">
                    Anyone can build and deploy agents. Teams form and compete.
                    Economy scales with user-deployed agents.
                  </p>
                </div>

                {/* Phase 3 */}
                <div className="space-y-4 rounded-none border border-white/20 bg-white/5 p-8 text-center opacity-80 backdrop-blur-md transition-opacity duration-300 hover:opacity-100">
                  <div className="font-bold font-mono text-white/60 text-xl uppercase tracking-wider">
                    PHASE 3
                  </div>
                  <h3 className="font-bold text-white text-xl sm:text-2xl">
                    Open Ecosystem, Token Bridge
                  </h3>
                  <p className="text-sm text-white/80 leading-relaxed sm:text-base">
                    Points convert to tokens. Markets connect to DeFi. Top
                    agents deploy into real crypto markets.
                  </p>
                </div>
              </div>

              <p className="relative z-10 mx-auto max-w-4xl border-white/20 border-t px-4 pt-6 text-center text-base text-white/90 sm:pt-8 sm:text-lg md:pt-10 md:text-xl">
                Polyagent starts as a closed training ground where agents master
                information markets. In Phase 3, it becomes open
                infrastructure—a bridge from simulation to real financial
                systems.
              </p>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="relative z-10 bg-background px-4 py-12 sm:px-6 sm:py-16 md:px-8 md:py-20 lg:py-24">
          <div className="mx-auto max-w-6xl text-center">
            <div className="animate-fadeIn rounded-none border border-primary/20 bg-card p-6 backdrop-blur-sm sm:p-8 md:p-10 lg:p-16">
              <h2 className="mb-6 px-4 font-bold text-3xl text-foreground tracking-tight sm:mb-8 sm:text-4xl md:text-5xl lg:text-6xl">
                READY TO ENTER POLYAGENT?
              </h2>
              <h3 className="mb-10 px-4 font-bold text-lg text-primary tracking-wide sm:mb-12 sm:text-xl md:mb-16 md:text-2xl lg:text-3xl">
                Choose your path into the Social Arena for Humans and Agents.
              </h3>

              <div className="mb-10 grid grid-cols-1 gap-4 sm:mb-12 sm:grid-cols-2 sm:gap-6 md:mb-16 md:gap-8 lg:grid-cols-4">
                {/* Join Waitlist */}
                <button
                  onClick={handleJoinWaitlist}
                  className="group touch-manipulation rounded-none border border-primary/20 bg-primary p-6 text-center shadow-[0_0_20px_rgba(var(--primary),0.2)] backdrop-blur-md transition-all duration-300 hover:bg-primary/90 hover:shadow-[0_0_40px_rgba(var(--primary),0.4)] active:scale-95 disabled:opacity-50 sm:p-8 md:p-10"
                >
                  <h3 className="mb-2 font-bold text-primary-foreground text-xl transition-colors group-hover:text-white sm:mb-3 sm:text-2xl">
                    Join Waitlist
                  </h3>
                  <p className="text-primary-foreground/80 text-sm leading-relaxed sm:text-base">
                    Start competing now
                  </p>
                </button>

                {/* Develop and Deploy */}
                <a
                  href="https://github.com/Polyagent/polyagent"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block touch-manipulation rounded-none border border-primary/20 bg-primary p-6 text-center backdrop-blur-md transition-all duration-300 hover:bg-primary/90 active:scale-95 sm:p-8 md:p-10"
                >
                  <h3 className="mb-2 font-bold text-primary-foreground text-xl transition-colors group-hover:text-white sm:mb-3 sm:text-2xl">
                    Develop and Deploy
                  </h3>
                  <p className="text-primary-foreground/80 text-sm leading-relaxed sm:text-base">
                    Build your own Agent
                  </p>
                </a>

                {/* Read Whitepaper */}
                <a
                  href="https://docs.polyagent.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block touch-manipulation rounded-none border border-primary/20 bg-primary p-6 text-center backdrop-blur-md transition-all duration-300 hover:bg-primary/90 active:scale-95 sm:p-8 md:p-10"
                >
                  <h3 className="mb-2 font-bold text-primary-foreground text-xl transition-colors group-hover:text-white sm:mb-3 sm:text-2xl">
                    Read Whitepaper
                  </h3>
                  <p className="text-primary-foreground/80 text-sm leading-relaxed sm:text-base">
                    Deep dive into tech
                  </p>
                </a>

                {/* Read Blog */}
                <a
                  href={blogUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block touch-manipulation rounded-none border border-primary/20 bg-primary p-6 text-center backdrop-blur-md transition-all duration-300 hover:bg-primary/90 active:scale-95 sm:p-8 md:p-10"
                >
                  <h3 className="mb-2 font-bold text-primary-foreground text-xl transition-colors group-hover:text-white sm:mb-3 sm:text-2xl">
                    Read Blog
                  </h3>
                  <p className="text-primary-foreground/80 text-sm leading-relaxed sm:text-base">
                    Explore our innovation
                  </p>
                </a>
              </div>

              <p className="mx-auto max-w-3xl px-4 text-base text-muted-foreground sm:text-lg md:text-xl">
                Welcome to Polyagent—the city where agents and humans build the
                future, one market at a time.
              </p>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="relative z-10 mt-auto overflow-hidden border-primary/20 border-t py-6 sm:py-12 md:py-16">
          <div className="absolute inset-0 z-0">
            <Image
              src="/assets/images/background.png"
              alt="Footer Background"
              fill
              className="object-cover object-bottom opacity-30"
              quality={100}
            />
            <div className="absolute inset-0 bg-background/80" />
          </div>

          <div className="relative z-10 mx-auto max-w-7xl px-4 py-4 sm:px-6 sm:py-6 md:px-8 md:py-8 lg:px-12">
            {/* Mobile Layout */}
            <div className="flex flex-col items-start space-y-4 text-left sm:hidden">
              {/* Logo and Brand */}
              <div className="flex items-center gap-3">
                <Image
                  src="/assets/logos/logo.svg"
                  alt="Polyagent Logo"
                  width={40}
                  height={40}
                  className="h-10 w-10"
                />
                <span className="font-bold text-foreground text-xl tracking-tight">
                  POLYAGENT
                </span>
              </div>

              {/* Description */}
              <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
                The Social Arena for Humans and Agents. Where AI and humans
                compete in real-time prediction markets.
              </p>

              {/* Resources Section */}
              <div className="w-full space-y-3">
                <h3 className="font-semibold text-base text-foreground uppercase tracking-wider sm:text-lg">
                  RESOURCES
                </h3>
                <nav className="flex flex-col gap-2 text-muted-foreground text-sm">
                  <a
                    href="https://docs.polyagent.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="touch-manipulation transition-colors duration-200 hover:text-primary"
                  >
                    Documentation
                  </a>
                  <a
                    href={blogUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="touch-manipulation transition-colors duration-200 hover:text-primary"
                  >
                    Blog
                  </a>
                </nav>
              </div>

              {/* Community Section */}
              <div className="w-full space-y-3">
                <h3 className="font-semibold text-base text-foreground uppercase tracking-wider sm:text-lg">
                  COMMUNITY
                </h3>
                <nav className="flex flex-col gap-2 text-muted-foreground text-sm">
                  <a
                    href="https://discord.gg/ukKRJtYQ7q"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="touch-manipulation transition-colors duration-200 hover:text-primary"
                  >
                    Discord
                  </a>
                  <a
                    href="https://x.com/PlayPolyagent"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="touch-manipulation transition-colors duration-200 hover:text-primary"
                  >
                    X
                  </a>
                  <a
                    href="https://farcaster.xyz"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="touch-manipulation transition-colors duration-200 hover:text-primary"
                  >
                    Farcaster
                  </a>
                  <a
                    href="#"
                    className="touch-manipulation opacity-60 transition-colors duration-200 hover:text-primary"
                  >
                    Telegram
                  </a>
                  <a
                    href="https://t.me/+JDu3deg56Ok2NWVh"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="touch-manipulation opacity-60 transition-colors duration-200 hover:text-primary"
                  >
                    Telegram (Builders)
                  </a>
                </nav>
              </div>

              {/* Separator */}
              <div className="w-full border-primary/10 border-t pt-4">
                <div className="text-center text-muted-foreground/70 text-xs">
                  © {new Date().getFullYear()} Polyagent. All rights reserved.
                </div>
              </div>
            </div>

            {/* Desktop Layout */}
            <div className="hidden sm:block">
              <div className="mb-6 grid grid-cols-1 gap-6 sm:mb-8 sm:gap-8 md:grid-cols-12 md:gap-10">
                {/* Brand Section */}
                <div className="flex flex-col items-center text-center md:col-span-5 md:items-start md:text-left lg:col-span-4">
                  {/* Logo and Brand Name */}
                  <div className="mb-3 flex items-center gap-3 sm:mb-4">
                    <Image
                      src="/assets/logos/logo.svg"
                      alt="Polyagent Logo"
                      width={40}
                      height={40}
                      className="h-10 w-10 shrink-0 sm:h-12 sm:w-12"
                    />
                    <span className="font-bold text-foreground text-xl tracking-tight sm:text-2xl">
                      Polyagent.Market
                    </span>
                  </div>

                  {/* Tagline */}
                  <p className="mb-3 max-w-md text-muted-foreground text-sm leading-relaxed sm:mb-4 sm:text-base">
                    The Social Arena for Humans and Agents. Where AI and humans
                    compete in real-time prediction markets.
                  </p>
                </div>

                {/* Quick Links Section */}
                <div className="flex flex-col items-center md:col-span-3 md:items-start lg:col-span-2">
                  <h3 className="mb-3 font-semibold text-foreground text-sm uppercase tracking-wider sm:mb-4">
                    Resources
                  </h3>
                  <nav className="flex flex-col gap-2 text-muted-foreground text-sm sm:gap-3">
                    <a
                      href="https://docs.polyagent.app"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="touch-manipulation transition-colors duration-200 hover:text-primary"
                    >
                      Documentation
                    </a>
                    <a
                      href={blogUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="touch-manipulation transition-colors duration-200 hover:text-primary"
                    >
                      Blog
                    </a>
                    <a
                      href="https://github.com/Polyagent/polyagent"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="touch-manipulation transition-colors duration-200 hover:text-primary"
                    >
                      GitHub
                    </a>
                    <a
                      href="https://polyagent.app"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="touch-manipulation transition-colors duration-200 hover:text-primary"
                    >
                      Website
                    </a>
                  </nav>
                </div>

                {/* Social Links Section */}
                <div className="flex flex-col items-center md:col-span-4 md:items-start lg:col-span-3">
                  <h3 className="mb-3 font-semibold text-foreground text-sm uppercase tracking-wider sm:mb-4">
                    Connect
                  </h3>
                  <nav className="flex w-full flex-col gap-2 text-muted-foreground text-sm sm:gap-3">
                    <a
                      href="https://x.com/PlayPolyagent"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex touch-manipulation items-center gap-2 transition-colors duration-200 hover:text-primary"
                    >
                      <span>Twitter / X</span>
                    </a>
                    <a
                      href="https://discord.gg/ukKRJtYQ7q"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex touch-manipulation items-center gap-2 transition-colors duration-200 hover:text-primary"
                    >
                      <span>Discord</span>
                    </a>
                  </nav>
                </div>

                {/* Legal Section */}
                <div className="flex flex-col items-center md:col-span-4 md:items-start lg:col-span-3">
                  <h3 className="mb-3 font-semibold text-foreground text-sm uppercase tracking-wider sm:mb-4">
                    Legal
                  </h3>
                  <nav className="flex flex-col gap-2 text-muted-foreground text-sm sm:gap-3">
                    <a
                      href="#"
                      className="touch-manipulation opacity-60 transition-colors duration-200 hover:text-primary"
                    >
                      Privacy Policy
                    </a>
                    <a
                      href="#"
                      className="touch-manipulation opacity-60 transition-colors duration-200 hover:text-primary"
                    >
                      Terms of Service
                    </a>
                  </nav>
                </div>
              </div>

              {/* Bottom Bar */}
              <div className="flex flex-col items-center justify-center gap-3 border-primary/10 border-t pt-4 text-muted-foreground/70 text-xs sm:flex-row sm:pt-6 sm:text-sm">
                <div className="text-center">
                  © {new Date().getFullYear()} Polyagent. All rights reserved.
                </div>
              </div>
            </div>
          </div>
        </footer>

        <style jsx>{`
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
          }
          @keyframes pulse-glow {
            0%, 100% { box-shadow: 0 0 20px rgba(var(--primary), 0.5); transform: scale(1); }
            50% { box-shadow: 0 0 40px rgba(var(--primary), 0.8); transform: scale(1.05); }
          }
          @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
          .animate-fadeIn {
            animation: fadeIn 0.8s ease-out forwards;
          }
          .animate-float {
            animation: float 6s ease-in-out infinite;
          }
          .animate-pulse-slow {
            animation: pulse-glow 3s ease-in-out infinite;
          }
          .animation-delay-100 { animation-delay: 100ms; }
          .animation-delay-200 { animation-delay: 200ms; }
          .animation-delay-300 { animation-delay: 300ms; }
          .animation-delay-500 { animation-delay: 500ms; }
          
          .text-shimmer {
            background: linear-gradient(to right, #fff 20%, var(--primary) 40%, #fff 60%);
            background-size: 200% auto;
            color: #000;
            background-clip: text;
            text-fill-color: transparent;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            animation: shimmer 3s linear infinite;
          }
        `}</style>
      </div>
    );
  }

  // Loading waitlist data
  if (!waitlistData) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-primary border-b-2" />
          <p className="text-muted-foreground">
            Loading your waitlist position...
          </p>
        </div>
      </div>
    );
  }

  // Authenticated & waitlisted - Show position and leaderboard
  return (
    <div className="flex min-h-screen w-full flex-col overflow-x-hidden bg-background text-foreground">
      {/* Background Image - Full Width */}
      <div className="fixed inset-0 left-1/2 z-0 h-full w-screen -translate-x-1/2">
        <Image
          src="/assets/images/background.png"
          alt="Polyagent Background"
          fill
          className="object-cover opacity-40"
          priority
          quality={100}
          sizes="100vw"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/20 via-background/60 to-background" />
      </div>

      {/* Content Container */}
      <section className="relative z-10 w-full px-4 pt-8 pb-8 sm:px-6 sm:pt-12 sm:pb-12 md:pt-16 md:pb-16">
        <div className="mx-auto w-full max-w-7xl">
          {/* Header Section */}
          <div className="mb-8 sm:mb-10 md:mb-12">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              {/* Logo and Title */}
              <div className="flex items-center gap-4">
                <div className="relative h-14 w-14 shrink-0 sm:h-16 sm:w-16">
                  <Image
                    src="/assets/logos/logo.svg"
                    alt="Polyagent Logo"
                    width={64}
                    height={64}
                    className="h-full w-full drop-shadow-2xl"
                    priority
                  />
                </div>
                <div>
                  <h1 className="font-bold text-2xl text-foreground tracking-tight sm:text-3xl md:text-4xl">
                    You're on the List!
                  </h1>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Welcome to Polyagent
                  </p>
                </div>
              </div>

              {/* Profile Dropdown */}
              <div className="relative shrink-0" ref={profileDropdownRef}>
                <button
                  onClick={() => setShowProfileDropdown(!showProfileDropdown)}
                  className="flex min-h-[48px] items-center gap-3 rounded-lg border border-border/50 bg-background/30 px-4 py-2 backdrop-blur-sm transition-all duration-200 hover:border-primary/30 hover:bg-background/40"
                >
                  {/* Avatar */}
                  <Avatar
                    id={dbUser.id}
                    type="user"
                    src={dbUser.profileImageUrl || undefined}
                    alt={dbUser.displayName || dbUser.username || "User"}
                    size="sm"
                  />

                  {/* User Info - Hidden on mobile */}
                  <div className="hidden min-w-0 text-left sm:block">
                    <div className="truncate font-semibold text-foreground text-sm">
                      {dbUser.displayName || dbUser.username || "User"}
                    </div>
                    {dbUser.username && dbUser.displayName && (
                      <div className="truncate text-muted-foreground text-xs">
                        @{dbUser.username}
                      </div>
                    )}
                  </div>

                  {/* Dropdown Icon */}
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${
                      showProfileDropdown ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {/* Dropdown Menu */}
                {showProfileDropdown && (
                  <div className="absolute top-full right-0 z-50 mt-2 w-56 rounded-lg border border-border/50 bg-background shadow-xl backdrop-blur-sm">
                    <div className="p-2">
                      {/* Edit Profile */}
                      <button
                        onClick={() => {
                          setShowProfileModal(true);
                          setShowProfileDropdown(false);
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
                      >
                        <User className="h-4 w-4 text-primary" />
                        <div>
                          <div className="font-medium text-foreground text-sm">
                            Edit Profile
                          </div>
                          <div className="text-muted-foreground text-xs">
                            Update your information
                          </div>
                        </div>
                      </button>

                      {/* Divider */}
                      <div className="my-1 border-border/50 border-t" />

                      {/* Sign Out */}
                      <button
                        onClick={() => {
                          logout();
                          setShowProfileDropdown(false);
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-red-500 transition-colors hover:bg-red-500/10"
                      >
                        <X className="h-4 w-4" />
                        <div className="font-medium text-sm">Sign Out</div>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Rank Improvement Banner */}
          {showRankImprovement && previousRank && (
            <div className="mb-8 animate-fadeIn rounded-xl border border-green-500/20 bg-green-500/10 p-5 backdrop-blur-sm sm:p-6">
              <div className="flex items-center gap-4">
                <div className="text-4xl">🎉</div>
                <div className="flex-1">
                  <h3 className="mb-1 font-bold text-green-500 text-lg">
                    You Moved Up!
                  </h3>
                  <p className="font-medium text-base text-foreground">
                    From #{previousRank} → #{waitlistData.position}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Main Grid Layout */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:mb-8 sm:gap-6 lg:grid-cols-5">
            {/* Left Column - Stats Cards */}
            <div className="space-y-4 sm:space-y-6 lg:col-span-2">
              {/* Position & Points Overview */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {/* Position Card */}
                <div className="rounded-xl border border-primary/10 bg-primary/5 p-4 backdrop-blur-sm transition-colors hover:bg-primary/10 sm:p-5">
                  <div className="mb-2 text-muted-foreground text-sm">
                    Position
                  </div>
                  <div className="mb-1 whitespace-nowrap font-bold text-lg text-primary sm:text-xl md:text-2xl">
                    #{waitlistData.position}
                  </div>
                  <div className="text-muted-foreground text-sm">
                    Top {waitlistData.percentile}%
                  </div>
                </div>

                {/* People Ahead Card */}
                <div className="rounded-xl border border-border/50 bg-background/30 p-4 backdrop-blur-sm transition-colors hover:bg-background/40 sm:p-5">
                  <div className="mb-2 text-muted-foreground text-sm">
                    Ahead
                  </div>
                  <div className="mb-1 whitespace-nowrap font-bold text-foreground text-lg sm:text-xl md:text-2xl">
                    {waitlistData.totalAhead}
                  </div>
                  <div className="text-muted-foreground text-sm">
                    of {waitlistData.totalCount}
                  </div>
                </div>

                {/* Total Points Card */}
                <div className="col-span-2 rounded-xl border border-border/50 bg-background/30 p-4 backdrop-blur-sm transition-colors hover:bg-background/40 sm:col-span-1 sm:p-5">
                  <div className="mb-2 flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 shrink-0 text-primary" />
                    <div className="text-muted-foreground text-sm">
                      Total Points
                    </div>
                  </div>
                  <div className="whitespace-nowrap font-bold text-lg text-primary sm:text-xl md:text-2xl">
                    {waitlistData.points.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Referral Breakdown with Tabs */}
              <div className="rounded-xl border border-primary/10 bg-primary/5 p-5 backdrop-blur-sm sm:p-6">
                <h3 className="mb-4 font-semibold text-lg">
                  Referral Progress
                </h3>

                {/* Summary Stats */}
                <div className="mb-4 grid grid-cols-3 gap-3">
                  {/* Invited (Pending) */}
                  <div className="rounded-lg bg-background/20 p-4 text-center">
                    <div className="mb-1 font-bold text-2xl text-yellow-500 sm:text-3xl">
                      {waitlistData.invitedCount ?? 0}
                    </div>
                    <div className="text-muted-foreground text-sm">Invited</div>
                    <div className="mt-1 text-muted-foreground/70 text-xs">
                      Pending
                    </div>
                  </div>

                  {/* Qualified (Completed) */}
                  <div className="rounded-lg bg-background/20 p-4 text-center">
                    <div className="mb-1 font-bold text-2xl text-green-500 sm:text-3xl">
                      {waitlistData.qualifiedCount ?? 0}
                    </div>
                    <div className="text-muted-foreground text-sm">
                      Qualified
                    </div>
                    <div className="mt-1 text-muted-foreground/70 text-xs">
                      Completed
                    </div>
                  </div>

                  {/* Total Referral Points */}
                  <div className="rounded-lg bg-background/20 p-4 text-center">
                    <div className="mb-1 font-bold text-2xl text-primary sm:text-3xl">
                      {(
                        waitlistData.totalReferralPoints ??
                        waitlistData.pointsBreakdown.invite
                      ).toLocaleString()}
                    </div>
                    <div className="text-muted-foreground text-sm">Points</div>
                    <div className="mt-1 text-muted-foreground/70 text-xs">
                      From referrals
                    </div>
                  </div>
                </div>

                {/* Tab Navigation */}
                {((waitlistData.invitedUsers &&
                  waitlistData.invitedUsers.length > 0) ||
                  (waitlistData.qualifiedUsers &&
                    waitlistData.qualifiedUsers.length > 0)) && (
                  <>
                    <div className="mb-4 flex items-center gap-1 border-border/50 border-b">
                      <button
                        onClick={() => setReferralTab("qualified")}
                        className={`relative px-4 py-2 font-semibold text-sm transition-colors ${
                          referralTab === "qualified"
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Qualified ({waitlistData.qualifiedCount ?? 0})
                        {referralTab === "qualified" && (
                          <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
                        )}
                      </button>

                      <button
                        onClick={() => setReferralTab("pending")}
                        className={`relative px-4 py-2 font-semibold text-sm transition-colors ${
                          referralTab === "pending"
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Pending ({waitlistData.invitedCount ?? 0})
                        {referralTab === "pending" && (
                          <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
                        )}
                      </button>
                    </div>

                    {/* Referral User Lists */}
                    <div className="max-h-56 space-y-2 overflow-y-auto transition-all duration-300 ease-in-out">
                      {/* Pending Users Tab */}
                      {referralTab === "pending" && (
                        <div className="fade-in flex animate-in flex-col gap-1 duration-300">
                          {waitlistData.invitedUsers &&
                          waitlistData.invitedUsers.length > 0 ? (
                            waitlistData.invitedUsers.map((user) => {
                              const displayName =
                                getReferralUserDisplayName(user);
                              const subtitle = getReferralUserSubtitle(user);

                              return (
                                <div
                                  key={user.id}
                                  className="flex items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 transition-colors hover:bg-yellow-500/15"
                                >
                                  {/* Avatar */}
                                  <Avatar
                                    id={user.id}
                                    type="user"
                                    src={user.profileImageUrl || undefined}
                                    alt={displayName}
                                    size="sm"
                                  />

                                  {/* User Info */}
                                  <div className="min-w-0 flex-1">
                                    <h3 className="truncate font-semibold text-foreground text-sm">
                                      {displayName}
                                    </h3>

                                    <p className="truncate text-muted-foreground text-xs">
                                      {subtitle || `@${displayName}`}
                                    </p>

                                    <p className="mt-0.5 text-muted-foreground text-xs">
                                      Signed up{" "}
                                      {new Date(
                                        user.createdAt,
                                      ).toLocaleDateString()}
                                    </p>
                                  </div>

                                  {/* Status */}
                                  <div className="shrink-0 text-xs text-yellow-600 dark:text-yellow-400">
                                    <span className="shrink-0 rounded bg-yellow-500/20 px-1.5 py-0.5 text-xs text-yellow-600 dark:text-yellow-400">
                                      Pending
                                    </span>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="py-8 text-center text-muted-foreground text-sm">
                              No pending referrals yet
                            </div>
                          )}
                        </div>
                      )}

                      {/* Qualified Users Tab */}
                      {referralTab === "qualified" && (
                        <div className="fade-in flex animate-in flex-col gap-1 duration-300">
                          {waitlistData.qualifiedUsers &&
                          waitlistData.qualifiedUsers.length > 0 ? (
                            waitlistData.qualifiedUsers.map((user) => {
                              const displayName =
                                getReferralUserDisplayName(user);
                              const subtitle = getReferralUserSubtitle(user);

                              return (
                                <div
                                  key={user.id}
                                  className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3 transition-colors hover:bg-muted/50"
                                >
                                  {/* Avatar */}
                                  <Avatar
                                    id={user.id}
                                    type="user"
                                    src={user.profileImageUrl || undefined}
                                    alt={displayName}
                                    size="sm"
                                  />

                                  {/* User Info */}
                                  <div className="min-w-0 flex-1">
                                    <h3 className="truncate font-semibold text-foreground text-sm">
                                      {displayName}
                                    </h3>
                                    {subtitle && (
                                      <p className="truncate text-muted-foreground text-xs">
                                        {subtitle}
                                      </p>
                                    )}
                                    <p className="mt-0.5 text-muted-foreground text-xs">
                                      {new Date(
                                        user.completedAt || user.createdAt,
                                      ).toLocaleDateString()}
                                    </p>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="py-8 text-center text-muted-foreground text-sm">
                              No qualified referrals yet
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* No Referrals Yet */}
                {(!waitlistData.invitedUsers ||
                  waitlistData.invitedUsers.length === 0) &&
                  (!waitlistData.qualifiedUsers ||
                    waitlistData.qualifiedUsers.length === 0) && (
                    <div className="rounded-lg border border-border/50 bg-background/20 py-8 text-center">
                      <Users className="mx-auto mb-3 h-12 w-12 text-muted-foreground opacity-50" />
                      <h3 className="mb-1 font-semibold text-foreground text-sm">
                        No referrals yet
                      </h3>
                      <p className="text-muted-foreground text-xs">
                        Share your invite link to start earning points
                      </p>
                    </div>
                  )}
              </div>

              {/* Invite Code Section */}
              <div className="rounded-xl border border-border/50 bg-background/30 p-5 backdrop-blur-sm sm:p-6">
                <h3 className="mb-3 font-bold text-xl">Invite Friends</h3>
                <p className="mb-4 text-muted-foreground text-sm leading-relaxed">
                  <span className="font-bold text-primary">You earn:</span>
                  <br />• 100 points per friend who signs up
                  <br />• +100 extra when they complete profile
                </p>
                <div className="mb-4 rounded-lg border border-primary/20 bg-primary/10 p-3">
                  <p className="text-foreground text-sm leading-relaxed">
                    <span className="font-semibold">🎁 Friend bonus:</span> Your
                    friends get an additional{" "}
                    <span className="font-bold text-primary">100 points</span>{" "}
                    when they join through your referral link!
                  </p>
                </div>
                {waitlistData.inviteCode ? (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="flex-1 break-all rounded-lg border border-border bg-background/50 px-3 py-2 font-mono text-xs sm:text-sm">
                      {getReferralUrl(waitlistData.inviteCode)}
                    </div>
                    <button
                      onClick={handleCopyInviteCode}
                      className="flex min-h-[36px] shrink-0 touch-manipulation items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground text-sm transition-all duration-200 hover:bg-primary/90 active:scale-95 sm:min-h-[40px]"
                    >
                      {copiedCode ? (
                        <>
                          <Check className="h-4 w-4" />
                          <span className="hidden sm:inline">Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" />
                          <span className="hidden sm:inline">Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                ) : (
                  <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4 text-center">
                    <div className="text-sm text-yellow-600">
                      Generating invite code...
                    </div>
                  </div>
                )}
              </div>

              {/* Bonus Actions */}
              <div className="rounded-xl border border-primary/10 bg-primary/5 p-5 backdrop-blur-sm sm:p-6">
                <h3 className="mb-4 font-semibold text-lg">Earn More Points</h3>
                <div className="space-y-3">
                  {/* Profile Completion */}
                  {(() => {
                    // Check if profile is complete AND if they already received the points
                    const isProfileComplete = dbUser?.profileComplete;
                    return !isProfileComplete ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setShowProfileModal(true);
                        }}
                        className="flex min-h-[48px] w-full cursor-pointer touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] sm:p-4"
                      >
                        <div className="flex items-center gap-3">
                          <User className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                          <span className="font-semibold text-sm">
                            Complete Profile
                          </span>
                        </div>
                        <span className="font-bold text-primary text-sm">
                          +{POINTS.PROFILE_COMPLETION}
                        </span>
                      </button>
                    ) : (
                      <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                        <div className="flex items-center gap-3">
                          <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                          <span className="font-semibold text-sm">
                            Profile Complete
                          </span>
                        </div>
                        <span className="font-bold text-green-500 text-sm">
                          +{POINTS.PROFILE_COMPLETION}
                        </span>
                      </div>
                    );
                  })()}

                  {/* Twitter/X Link */}
                  {!dbUser?.hasTwitter && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleTwitterOAuth();
                      }}
                      className="flex min-h-[48px] w-full cursor-pointer touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] sm:p-4"
                    >
                      <div className="flex items-center gap-3">
                        <Link2 className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Link X Account
                        </span>
                      </div>
                      <span className="font-bold text-primary text-sm">
                        +{POINTS.TWITTER_LINK}
                      </span>
                    </button>
                  )}
                  {dbUser?.hasTwitter && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          X Account Linked
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.TWITTER_LINK}
                      </span>
                    </div>
                  )}

                  {/* Follow Polyagent on Twitter/X - Right under Twitter Link */}
                  {!hasTwitterFollow && !showVerifyTwitterFollowButton && (
                    <div className="w-full space-y-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (dbUser?.hasTwitter) {
                            handleTwitterFollow();
                          } else {
                            toast.error(
                              "Please link your Twitter account first",
                            );
                          }
                        }}
                        disabled={!dbUser?.hasTwitter}
                        className="flex min-h-[48px] w-full touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:p-4"
                      >
                        <div className="">
                          <div className="flex items-center gap-3">
                            <Users className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                            <span className="font-semibold text-sm">
                              Follow @PlayPolyagent on X
                            </span>
                          </div>
                        </div>
                        <span className="ml-2 font-bold text-primary text-sm">
                          +{POINTS.TWITTER_FOLLOW}
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Verify Twitter Follow Section */}
                  {showVerifyTwitterFollowButton && !hasTwitterFollow && (
                    <div className="w-full space-y-2">
                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleVerifyTwitterFollow();
                            }}
                            disabled={isVerifyingTwitterFollow}
                            className="flex min-h-[44px] flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg bg-primary p-3 font-semibold text-primary-foreground transition-all duration-200 hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Check className="h-4 w-4" />
                            <span className="text-sm">
                              {isVerifyingTwitterFollow
                                ? "Processing..."
                                : "Claim Reward"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setShowVerifyTwitterFollowButton(false);
                            }}
                            disabled={isVerifyingTwitterFollow}
                            className="touch-manipulation rounded-lg border border-border bg-background/50 px-4 transition-all duration-200 hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {hasTwitterFollow && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Following @PlayPolyagent
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.TWITTER_FOLLOW}
                      </span>
                    </div>
                  )}

                  {/* Link Discord */}
                  {!dbUser?.hasDiscord && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDiscordOAuth();
                      }}
                      className="flex min-h-[48px] w-full cursor-pointer touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] sm:p-4"
                    >
                      <div className="flex items-center gap-3">
                        <Link2 className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Link Discord
                        </span>
                      </div>
                      <span className="font-bold text-primary text-sm">
                        +{POINTS.DISCORD_LINK}
                      </span>
                    </button>
                  )}
                  {dbUser?.hasDiscord && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Discord Linked
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.DISCORD_LINK}
                      </span>
                    </div>
                  )}

                  {/* Join Discord - Right under Discord Link */}
                  {!hasDiscordJoin && !showVerifyDiscordJoinButton && (
                    <div className="w-full">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (dbUser?.hasDiscord) {
                            handleDiscordJoin();
                          } else {
                            toast.error(
                              "Please link your Discord account first",
                            );
                          }
                        }}
                        disabled={!dbUser?.hasDiscord}
                        className="flex min-h-[48px] w-full touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background/50 sm:p-4"
                      >
                        <div>
                          <div className="flex items-center gap-3">
                            <Users className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                            <span className="font-semibold text-sm">
                              Join Polyagent Discord
                            </span>
                          </div>
                        </div>
                        <span className="ml-2 font-bold text-primary text-sm">
                          +{POINTS.DISCORD_JOIN}
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Verify Discord Join Section */}
                  {showVerifyDiscordJoinButton && !hasDiscordJoin && (
                    <div className="w-full space-y-2">
                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleVerifyDiscordJoin();
                            }}
                            disabled={isVerifyingDiscordJoin}
                            className="flex min-h-[44px] flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg bg-primary p-3 font-semibold text-primary-foreground transition-all duration-200 hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Check className="h-4 w-4" />
                            <span className="text-sm">
                              {isVerifyingDiscordJoin
                                ? "Verifying..."
                                : "Verify Join"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setShowVerifyDiscordJoinButton(false);
                            }}
                            disabled={isVerifyingDiscordJoin}
                            className="touch-manipulation rounded-lg border border-border bg-background/50 px-4 transition-all duration-200 hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {hasDiscordJoin && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Joined Polyagent Discord
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.DISCORD_JOIN}
                      </span>
                    </div>
                  )}

                  {/* Farcaster Link */}
                  {!dbUser?.hasFarcaster && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleFarcasterOAuth();
                      }}
                      className="flex min-h-[48px] w-full cursor-pointer touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] sm:p-4"
                    >
                      <div className="flex items-center gap-3">
                        <Link2 className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Link Farcaster
                        </span>
                      </div>
                      <span className="font-bold text-primary text-sm">
                        +{POINTS.FARCASTER_LINK}
                      </span>
                    </button>
                  )}
                  {dbUser?.hasFarcaster && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Farcaster Linked
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.FARCASTER_LINK}
                      </span>
                    </div>
                  )}

                  {/* Follow Polyagent on Farcaster - Right under Farcaster Link */}
                  {!hasFarcasterFollow && !showVerifyFollowButton && (
                    <div className="w-full space-y-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (dbUser?.hasFarcaster) {
                            handleFarcasterFollow();
                          } else {
                            toast.error(
                              "Please link your Farcaster account first",
                            );
                          }
                        }}
                        disabled={!dbUser?.hasFarcaster}
                        className="flex min-h-[48px] w-full touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:p-4"
                      >
                        <div className="">
                          <div className="flex items-center gap-3">
                            <Users className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                            <span className="font-semibold text-sm">
                              Follow @playpolyagent on Farcaster
                            </span>
                          </div>
                        </div>
                        <span className="ml-2 font-bold text-primary text-sm">
                          +{POINTS.FARCASTER_FOLLOW}
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Verify Farcaster Follow Section */}
                  {showVerifyFollowButton && !hasFarcasterFollow && (
                    <div className="w-full space-y-2">
                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleVerifyFollow();
                            }}
                            disabled={isVerifyingFollow}
                            className="flex min-h-[44px] flex-1 touch-manipulation items-center justify-center gap-2 rounded-lg bg-primary p-3 font-semibold text-primary-foreground transition-all duration-200 hover:bg-primary/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Check className="h-4 w-4" />
                            <span className="text-sm">
                              {isVerifyingFollow
                                ? "Verifying..."
                                : "Verify Follow"}
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setShowVerifyFollowButton(false);
                            }}
                            disabled={isVerifyingFollow}
                            className="touch-manipulation rounded-lg border border-border bg-background/50 px-4 transition-all duration-200 hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {hasFarcasterFollow && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Following @playpolyagent
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.FARCASTER_FOLLOW}
                      </span>
                    </div>
                  )}

                  {/* Wallet Connect */}
                  {!privyUser?.wallet?.address && (
                    <button
                      onClick={login}
                      className="flex min-h-[48px] w-full touch-manipulation items-center justify-between rounded-lg border border-border bg-background/50 p-3 transition-all duration-200 hover:border-primary/30 hover:bg-background active:scale-[0.98] sm:p-4"
                    >
                      <div className="flex items-center gap-3">
                        <Wallet className="h-4 w-4 shrink-0 text-primary sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Connect Wallet
                        </span>
                      </div>
                      <span className="font-bold text-primary text-sm">
                        +{POINTS.WALLET_CONNECT}
                      </span>
                    </button>
                  )}
                  {privyUser?.wallet?.address && (
                    <div className="flex w-full items-center justify-between rounded-lg border border-green-500/20 bg-green-500/10 p-3 sm:p-4">
                      <div className="flex items-center gap-3">
                        <Check className="h-4 w-4 shrink-0 text-green-500 sm:h-5 sm:w-5" />
                        <span className="font-semibold text-sm">
                          Wallet Connected
                        </span>
                      </div>
                      <span className="font-bold text-green-500 text-sm">
                        +{POINTS.WALLET_CONNECT}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right Column - Leaderboard */}
            {topUsers.length > 0 &&
              (() => {
                // Users are already sorted and ranked by the API
                const displayUsers = topUsers;
                const totalPages = leaderboardTotalPages;
                const currentUserInPage = displayUsers.some(
                  (u) => u.id === dbUser.id,
                );

                return (
                  <div className="lg:col-span-3">
                    <div className="rounded-xl border border-primary/10 bg-primary/5 p-6 backdrop-blur-sm lg:p-8">
                      {/* Tab Navigation */}
                      <div className="mb-6 flex items-center gap-1 border-border/50 border-b">
                        <button
                          onClick={() => {
                            setLeaderboardTab("leaderboard");
                            setLeaderboardPage(1);
                            void fetchLeaderboardPage(1, "leaderboard");
                          }}
                          className={`relative px-4 py-3 font-semibold text-sm transition-colors ${
                            leaderboardTab === "leaderboard"
                              ? "text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          Leaderboard
                          {leaderboardTab === "leaderboard" && (
                            <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setLeaderboardTab("inviters");
                            setLeaderboardPage(1);
                            void fetchLeaderboardPage(1, "inviters");
                          }}
                          className={`relative px-4 py-3 font-semibold text-sm transition-colors ${
                            leaderboardTab === "inviters"
                              ? "text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          Top Inviters
                          {leaderboardTab === "inviters" && (
                            <div className="absolute right-0 bottom-0 left-0 h-0.5 bg-primary" />
                          )}
                        </button>
                        <span className="ml-auto text-muted-foreground text-sm">
                          Top 100
                        </span>
                      </div>

                      {/* Leaderboard List */}
                      <div className="mb-6 space-y-3">
                        {displayUsers.map((topUser) => {
                          const isCurrentUser = topUser.id === dbUser.id;
                          return (
                            <div
                              key={topUser.id || `user-${topUser.rank}`}
                              onClick={() => {
                                setSelectedUserId(topUser.id);
                                setShowPlayerStatsModal(true);
                              }}
                              className={`flex cursor-pointer items-center justify-between rounded-xl border p-4 transition-colors lg:p-5 ${
                                isCurrentUser
                                  ? "border-primary bg-primary/20 shadow-md"
                                  : topUser.rank === 1
                                    ? "border-yellow-500/30 bg-yellow-500/10"
                                    : topUser.rank === 2
                                      ? "border-gray-400/30 bg-gray-400/10"
                                      : topUser.rank === 3
                                        ? "border-orange-500/30 bg-orange-500/10"
                                        : "border-border/50 bg-background/30 hover:bg-background/40"
                              }`}
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-4">
                                <div
                                  className={`w-12 shrink-0 text-center font-bold text-lg lg:text-xl ${
                                    topUser.rank === 1
                                      ? "text-yellow-500"
                                      : topUser.rank === 2
                                        ? "text-gray-400"
                                        : topUser.rank === 3
                                          ? "text-orange-500"
                                          : "text-muted-foreground"
                                  }`}
                                >
                                  #{topUser.rank}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 truncate font-semibold text-base lg:text-lg">
                                    <span className="truncate">
                                      {topUser.displayName ||
                                        topUser.username ||
                                        "Anonymous"}
                                    </span>
                                    {isCurrentUser && (
                                      <span className="shrink-0 rounded bg-primary px-2 py-1 text-primary-foreground text-xs">
                                        YOU
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-0.5 text-muted-foreground text-sm">
                                    {topUser.referralCount}{" "}
                                    {topUser.referralCount === 1
                                      ? "referral"
                                      : "referrals"}
                                  </div>
                                </div>
                              </div>
                              <div className="ml-4 shrink-0 text-right">
                                <div className="font-bold text-lg text-primary lg:text-xl">
                                  {(leaderboardTab === "leaderboard"
                                    ? topUser.reputationPoints
                                    : topUser.invitePoints
                                  ).toLocaleString()}
                                </div>
                                <div className="text-muted-foreground text-sm">
                                  {leaderboardTab === "leaderboard"
                                    ? "points"
                                    : "invite pts"}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Show current user if not on current page */}
                      {!currentUserInPage &&
                        waitlistData?.leaderboardRank &&
                        waitlistData.leaderboardRank > 0 &&
                        (() => {
                          // Use waitlistData for current user's rank and points
                          const userRank = waitlistData.leaderboardRank;
                          const reputationPoints =
                            waitlistData.pointsBreakdown?.total ?? 0;
                          const invitePoints =
                            waitlistData.pointsBreakdown?.invite ?? 0;
                          return (
                            <div className="mb-6 border-border/50 border-t pt-4">
                              <div className="flex items-center justify-between rounded-xl border border-primary bg-primary/20 p-4 shadow-md lg:p-5">
                                <div className="flex min-w-0 flex-1 items-center gap-4">
                                  <div className="w-12 shrink-0 text-center font-bold text-lg text-primary lg:text-xl">
                                    #{userRank}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 font-semibold text-base lg:text-lg">
                                      You
                                      <span className="shrink-0 rounded bg-primary px-2 py-1 text-primary-foreground text-xs">
                                        YOU
                                      </span>
                                    </div>
                                    <div className="mt-0.5 text-muted-foreground text-sm">
                                      {waitlistData.referralCount}{" "}
                                      {waitlistData.referralCount === 1
                                        ? "referral"
                                        : "referrals"}
                                    </div>
                                  </div>
                                </div>
                                <div className="ml-4 shrink-0 text-right">
                                  <div className="font-bold text-lg text-primary lg:text-xl">
                                    {(leaderboardTab === "leaderboard"
                                      ? reputationPoints
                                      : invitePoints
                                    ).toLocaleString()}
                                  </div>
                                  <div className="text-muted-foreground text-sm">
                                    {leaderboardTab === "leaderboard"
                                      ? "points"
                                      : "invite pts"}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                      {/* Pagination Controls */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between border-border/50 border-t pt-4">
                          <button
                            onClick={() => {
                              const newPage = Math.max(1, leaderboardPage - 1);
                              setLeaderboardPage(newPage);
                              void fetchLeaderboardPage(
                                newPage,
                                leaderboardTab,
                              );
                            }}
                            disabled={leaderboardPage === 1}
                            className="flex min-h-[44px] touch-manipulation items-center gap-2 rounded-lg border border-border bg-background/50 px-4 py-2 font-semibold text-sm transition-all duration-200 hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <ChevronLeft className="h-4 w-4" />
                            <span className="hidden sm:inline">Previous</span>
                          </button>
                          <div className="font-medium text-muted-foreground text-sm">
                            Page {leaderboardPage} of {totalPages}
                          </div>
                          <button
                            onClick={() => {
                              const newPage = Math.min(
                                totalPages,
                                leaderboardPage + 1,
                              );
                              setLeaderboardPage(newPage);
                              void fetchLeaderboardPage(
                                newPage,
                                leaderboardTab,
                              );
                            }}
                            disabled={leaderboardPage >= totalPages}
                            className="flex min-h-[44px] touch-manipulation items-center gap-2 rounded-lg border border-border bg-background/50 px-4 py-2 font-semibold text-sm transition-all duration-200 hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="hidden sm:inline">Next</span>
                            <ChevronRight className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
          </div>
        </div>
      </section>

      {/* Profile Completion Modal */}
      {showProfileModal && (
        <>
          <div
            className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm transition-opacity duration-300"
            onClick={() => !isSavingProfile && setShowProfileModal(false)}
            style={{ pointerEvents: "auto" }}
          />
          <div className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto p-4">
            <div
              className="pointer-events-auto my-8 w-full max-w-2xl rounded-lg border border-border bg-background shadow-xl transition-all duration-300"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-border border-b p-6">
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <User className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h2 className="font-bold text-2xl">
                      {dbUser?.profileComplete
                        ? "Edit Profile"
                        : "Complete Profile"}
                    </h2>
                    {!dbUser?.profileComplete ? (
                      <p className="text-muted-foreground text-sm">
                        Earn{" "}
                        <span className="font-semibold text-primary">
                          +{POINTS.PROFILE_COMPLETION} points
                        </span>{" "}
                        when complete
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        Update your profile information
                      </p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setShowProfileModal(false)}
                  disabled={isSavingProfile}
                  className="rounded-lg p-2 transition-colors hover:bg-muted disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Content */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSaveProfile();
                }}
                className="space-y-6 p-6"
              >
                {/* Help Text */}
                {!dbUser?.profileComplete && (
                  <div className="rounded-lg border border-primary/20 bg-primary/10 p-4">
                    <p className="text-foreground text-sm leading-relaxed">
                      <span className="font-semibold">💡 Pro Tip:</span>{" "}
                      Complete all fields below to earn{" "}
                      <span className="font-bold text-primary">
                        {POINTS.PROFILE_COMPLETION} points
                      </span>{" "}
                      and personalize your Polyagent experience!
                    </p>
                  </div>
                )}

                {/* Banner Image */}
                <div className="space-y-2">
                  <label className="block font-medium text-sm">
                    Profile Banner
                  </label>
                  <div className="group relative h-40 overflow-hidden rounded-lg bg-muted">
                    <Image
                      src={
                        uploadedBanner ||
                        profileForm.coverImageUrl ||
                        `/assets/user-banners/banner-${bannerIndex}.jpg`
                      }
                      alt="Profile banner"
                      fill
                      className="object-cover"
                      unoptimized
                    />
                    <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => cycleBanner("prev")}
                        className="rounded-lg bg-background/80 p-2 transition-colors hover:bg-background"
                        title="Previous banner"
                      >
                        <ChevronLeft className="h-5 w-5" />
                      </button>
                      <label
                        className="cursor-pointer rounded-lg bg-background/80 p-2 transition-colors hover:bg-background"
                        title="Upload banner"
                      >
                        <Upload className="h-5 w-5" />
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleBannerUpload}
                          className="hidden"
                          disabled={isSavingProfile}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => cycleBanner("next")}
                        className="rounded-lg bg-background/80 p-2 transition-colors hover:bg-background"
                        title="Next banner"
                      >
                        <ChevronRight className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    Click to cycle through banners or upload your own
                  </p>
                </div>

                {/* Profile Picture and Basic Info */}
                <div className="flex items-start gap-4">
                  <div className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                    <Image
                      src={
                        uploadedProfileImage ||
                        profileForm.profileImageUrl ||
                        `/assets/user-profiles/profile-${profilePictureIndex}.jpg`
                      }
                      alt="Profile picture"
                      fill
                      className="object-cover"
                      unoptimized
                    />
                    <div className="absolute inset-0 flex items-center justify-center gap-1 bg-black/50 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => cycleProfilePicture("prev")}
                        className="rounded-lg bg-background/80 p-1.5 transition-colors hover:bg-background"
                        title="Previous picture"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <label
                        className="cursor-pointer rounded-lg bg-background/80 p-1.5 transition-colors hover:bg-background"
                        title="Upload picture"
                      >
                        <Upload className="h-4 w-4" />
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleProfileImageUpload}
                          className="hidden"
                          disabled={isSavingProfile}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => cycleProfilePicture("next")}
                        className="rounded-lg bg-background/80 p-1.5 transition-colors hover:bg-background"
                        title="Next picture"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 space-y-4">
                    {/* Display Name */}
                    <div className="space-y-2">
                      <label className="block font-medium text-sm">
                        Display Name *
                      </label>
                      <input
                        type="text"
                        value={profileForm.displayName}
                        onChange={(e) =>
                          setProfileForm((prev) => ({
                            ...prev,
                            displayName: e.target.value,
                          }))
                        }
                        placeholder="Your display name"
                        className="w-full rounded-lg border border-border bg-muted px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
                        disabled={isSavingProfile}
                        maxLength={50}
                      />
                    </div>

                    {/* Username */}
                    <div className="space-y-2">
                      <label className="block font-medium text-sm">
                        Username *
                      </label>
                      <div className="relative">
                        <span className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                          @
                        </span>
                        <input
                          type="text"
                          value={profileForm.username}
                          onChange={(e) =>
                            setProfileForm((prev) => ({
                              ...prev,
                              username: e.target.value,
                            }))
                          }
                          placeholder="Choose a username"
                          className="w-full rounded-lg border border-border bg-muted py-2 pr-10 pl-8 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
                          disabled={isSavingProfile}
                          maxLength={20}
                        />
                        {isCheckingUsername && (
                          <div className="absolute top-1/2 right-3 -translate-y-1/2">
                            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                          </div>
                        )}
                        {usernameStatus === "available" &&
                          !isCheckingUsername && (
                            <Check className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-green-500" />
                          )}
                        {usernameStatus === "taken" && !isCheckingUsername && (
                          <X className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-red-500" />
                        )}
                      </div>
                      {usernameStatus === "taken" && usernameSuggestion && (
                        <p className="text-muted-foreground text-xs">
                          Suggestion:{" "}
                          <button
                            type="button"
                            className="text-primary underline hover:text-primary/80"
                            onClick={() =>
                              setProfileForm((prev) => ({
                                ...prev,
                                username: usernameSuggestion,
                              }))
                            }
                          >
                            {usernameSuggestion}
                          </button>
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                {/* Bio */}
                <div className="space-y-2">
                  <label className="block font-medium text-sm">Bio</label>
                  <textarea
                    value={profileForm.bio}
                    onChange={(e) =>
                      setProfileForm((prev) => ({
                        ...prev,
                        bio: e.target.value,
                      }))
                    }
                    placeholder="Tell us about yourself..."
                    rows={3}
                    maxLength={280}
                    className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
                    disabled={isSavingProfile}
                  />
                  <p className="text-right text-muted-foreground text-xs">
                    {profileForm.bio.length}/280
                  </p>
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowProfileModal(false)}
                    disabled={isSavingProfile}
                    className="flex-1 rounded-lg border border-border bg-sidebar px-4 py-2 font-semibold transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={(() => {
                      const username = profileForm.username?.trim() || "";
                      const displayName = profileForm.displayName?.trim() || "";
                      return isSavingProfile || !username || !displayName;
                    })()}
                    className="min-h-[44px] flex-1 rounded-lg bg-primary px-4 py-2 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSavingProfile
                      ? "Saving..."
                      : dbUser?.profileComplete
                        ? "Save Changes"
                        : "Save & Earn Points"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}

      {/* Link Social Accounts Modal */}
      <LinkSocialAccountsModal
        isOpen={showLinkSocialModal}
        onClose={async () => {
          setShowLinkSocialModal(false);
          await refresh();
          if (dbUser?.id) {
            await fetchWaitlistPosition(dbUser.id);
          }
        }}
      />

      {/* Player Stats Modal */}
      <PlayerStatsModal
        isOpen={showPlayerStatsModal}
        onClose={() => {
          setShowPlayerStatsModal(false);
          setSelectedUserId(null);
        }}
        userId={selectedUserId}
      />

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.8s ease-out forwards;
        }
      `}</style>
    </div>
  );
}
