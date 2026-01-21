"use client";

import { getDisplayReferralUrl, getReferralUrl } from "@babylon/shared";
import { Check, Copy, Key, LogOut, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { Dropdown, DropdownItem } from "@/components/shared/Dropdown";
import { useAuth } from "@/hooks/useAuth";
import { getAuthToken } from "@/lib/auth";
import { useAuthStore } from "@/stores/authStore";

/**
 * Global fetch tracking to prevent duplicate calls across all UserMenu instances.
 */
let userMenuFetchInFlight = false;
let userMenuIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * User menu component displaying user profile and account actions.
 *
 * Shows user avatar, name, username, points balance, referral code, and logout
 * option in a dropdown menu. Automatically fetches and refreshes user data every
 * 30 seconds. Prevents duplicate API calls across multiple instances.
 *
 * Features:
 * - User profile display with avatar
 * - Points balance (total reputation and available trading balance)
 * - Referral code copy functionality
 * - Logout action
 *
 * @returns User menu dropdown element or null if no user
 */
export function UserMenu() {
  const { logout, refresh } = useAuth();
  const { user, setUser } = useAuthStore();
  const router = useRouter();
  const [tradingBalance, setTradingBalance] = useState<number | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const lastFetchedUserIdRef = useRef<string | null>(null);
  const lastFetchTimeRef = useRef<number>(0);

  useEffect(() => {
    let isMounted = true;
    let currentFetchController: AbortController | null = null;

    const fetchData = async (forceRefresh = false) => {
      if (!user?.id || !isMounted) {
        if (!isMounted) return;
        setTradingBalance(null);
        lastFetchedUserIdRef.current = null;
        return;
      }

      // Skip if we fetched recently (within 5 seconds) unless force refresh
      const now = Date.now();
      if (
        !forceRefresh &&
        now - lastFetchTimeRef.current < 5000 &&
        lastFetchedUserIdRef.current === user.id
      ) {
        return;
      }

      // Prevent duplicate fetches globally
      if (userMenuFetchInFlight) return;
      userMenuFetchInFlight = true;

      const token = getAuthToken();
      if (!token) {
        userMenuFetchInFlight = false;
        return;
      }

      const headers: HeadersInit = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      // Create a new controller for this specific fetch call
      currentFetchController = new AbortController();
      const fetchController = currentFetchController;

      // Fetch both trading balance and user profile (for latest reputation points)
      const [balanceResponse, profileResponse] = await Promise.all([
        fetch(`/api/users/${encodeURIComponent(user.id)}/balance`, {
          headers,
          signal: fetchController.signal,
        }),
        fetch(`/api/users/${encodeURIComponent(user.id)}/profile`, {
          headers,
          signal: fetchController.signal,
        }),
      ]).catch((error) => {
        // Ignore abort errors
        if (error instanceof Error && error.name === "AbortError") {
          return [null, null];
        }
        // Silently handle network errors - component will show previous state or null
        if (isMounted) {
          console.warn("Failed to fetch user menu data:", error);
        }
        return [null, null];
      });

      if (
        !isMounted ||
        fetchController.signal.aborted ||
        !balanceResponse ||
        !profileResponse
      ) {
        if (isMounted) {
          userMenuFetchInFlight = false;
        }
        currentFetchController = null;
        return;
      }

      // Update trading balance
      if (balanceResponse.ok) {
        const balanceData = await balanceResponse.json();
        if (isMounted && !fetchController.signal.aborted) {
          setTradingBalance(Number(balanceData.balance || 0));
        }
      }

      // Update reputation points from profile
      if (profileResponse.ok) {
        const profileData = await profileResponse.json();
        if (isMounted && !fetchController.signal.aborted && profileData.user) {
          const newReputationPoints = profileData.user.reputationPoints;
          // Only update if reputation points changed
          if (
            newReputationPoints !== undefined &&
            newReputationPoints !== user.reputationPoints
          ) {
            setUser({
              ...user,
              reputationPoints: newReputationPoints,
            });
          }
        }
      }

      if (isMounted && !fetchController.signal.aborted) {
        lastFetchedUserIdRef.current = user.id;
        lastFetchTimeRef.current = now;
      }

      if (isMounted) {
        userMenuFetchInFlight = false;
      }
      currentFetchController = null;
    };

    // Clear any existing interval
    if (userMenuIntervalId) {
      clearInterval(userMenuIntervalId);
      userMenuIntervalId = null;
    }

    // Fetch immediately when user changes or reputation points change
    const shouldRefresh = lastFetchedUserIdRef.current !== user?.id;
    fetchData(shouldRefresh);

    // Set up interval for refresh
    userMenuIntervalId = setInterval(() => {
      if (isMounted) {
        fetchData(true);
      }
    }, 30000);

    return () => {
      isMounted = false;
      if (currentFetchController) {
        currentFetchController.abort();
      }
      if (userMenuIntervalId) {
        clearInterval(userMenuIntervalId);
        userMenuIntervalId = null;
      }
    };
  }, [user?.id, user?.reputationPoints, setUser, user]);

  // Listen for rewards-updated events to refresh auth state
  // This ensures the sidebar updates when rewards are claimed elsewhere
  useEffect(() => {
    const handleRewardsUpdated = () => {
      // Refresh the auth state to get latest reputation points
      refresh();
    };

    window.addEventListener("rewards-updated", handleRewardsUpdated);
    return () => {
      window.removeEventListener("rewards-updated", handleRewardsUpdated);
    };
  }, [refresh]);

  const handleCopyReferralCode = async () => {
    if (!user?.referralCode) return;
    const referralUrl = getReferralUrl(user.referralCode);
    await navigator.clipboard.writeText(referralUrl);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  if (!user) {
    return null;
  }

  const displayName =
    user.displayName || user.email?.split("@")[0] || "Anonymous";
  const username = user.username || `user${user.id.slice(0, 8)}`;

  const trigger = (
    <div
      data-testid="user-menu"
      className="flex cursor-pointer items-center gap-3 rounded-full px-3 py-2.5 transition-colors hover:bg-sidebar-accent"
    >
      <Avatar
        id={user.id}
        name={displayName}
        type="user"
        size="sm"
        src={user.profileImageUrl || undefined}
        imageUrl={user.profileImageUrl || undefined}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-[15px] text-sidebar-foreground leading-5">
          {displayName}
        </p>
        <p className="truncate text-[13px] text-muted-foreground leading-4">
          @{username}
        </p>
      </div>
    </div>
  );

  // Use reputation points from authStore (synced when rewards are claimed)
  const reputationPoints = user?.reputationPoints ?? 0;
  const tradingBalanceValue = tradingBalance ?? 0;

  return (
    <Dropdown trigger={trigger} placement="top-right" width="default">
      {/* Points Display */}
      <div className="border-sidebar-accent border-b px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-muted-foreground text-sm">
            Reputation
          </span>
          <span className="font-bold text-foreground text-xl">
            {reputationPoints.toLocaleString()}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-muted-foreground text-xs">Trading Balance</span>
          <span className="font-semibold text-foreground text-sm">
            {tradingBalanceValue.toLocaleString()}
          </span>
        </div>
      </div>

      {user?.referralCode && (
        <DropdownItem onClick={handleCopyReferralCode}>
          <div className="flex items-center gap-3 py-2">
            {copiedCode ? (
              <>
                <Check className="h-5 w-5 text-green-500" />
                <span className="font-semibold text-green-500 text-sm">
                  Link Copied!
                </span>
              </>
            ) : (
              <>
                <Copy className="h-5 w-5" style={{ color: "#0066FF" }} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold text-foreground text-sm">
                    Copy Referral Link
                  </span>
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {getDisplayReferralUrl(user.referralCode)}
                  </span>
                </div>
              </>
            )}
          </div>
        </DropdownItem>
      )}

      <DropdownItem onClick={() => router.push("/settings")}>
        <div className="flex items-center gap-3 py-2">
          <Settings className="h-5 w-5" style={{ color: "#0066FF" }} />
          <span className="font-semibold text-foreground text-sm">
            Settings
          </span>
        </div>
      </DropdownItem>

      <DropdownItem onClick={() => router.push("/settings?tab=api")}>
        <div className="flex items-center gap-3 py-2">
          <Key className="h-5 w-5" style={{ color: "#0066FF" }} />
          <span className="font-semibold text-foreground text-sm">
            API Keys
          </span>
        </div>
      </DropdownItem>

      <DropdownItem onClick={logout}>
        <div className="flex items-center gap-3 py-2 text-destructive hover:text-destructive/90">
          <LogOut className="h-5 w-5" />
          <span className="font-semibold">Logout</span>
        </div>
      </DropdownItem>
    </Dropdown>
  );
}
