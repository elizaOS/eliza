"use client";

import { cn, getDisplayReferralUrl, getReferralUrl } from "@polyagent/shared";
import {
  Bell,
  Check,
  Copy,
  Gift,
  Home,
  LogOut,
  MessageCircle,
  TrendingUp,
  Trophy,
  X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/shared/Avatar";
import { useAuth } from "@/hooks/useAuth";
import { getAuthToken } from "@/lib/auth";
import { useAuthStore } from "@/stores/authStore";

/**
 * Mobile header content component for mobile devices.
 *
 * Provides a fixed header with logo, profile menu trigger, and slide-out
 * side menu. Shows user profile, navigation links, points balance, referral
 * code, and logout. Automatically hides when WAITLIST_MODE is enabled on
 * home page.
 *
 * @returns Mobile header element or null if hidden
 */
function MobileHeaderContent() {
  const { authenticated, logout } = useAuth();
  const { user, setUser } = useAuthStore();
  const [showSideMenu, setShowSideMenu] = useState(false);
  const [pointsData, setPointsData] = useState<{
    available: number;
    total: number;
  } | null>(null);
  const [copiedReferral, setCopiedReferral] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const pathname = usePathname();

  // Hide mobile header when WAITLIST_MODE is enabled on home page
  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === "true";
  const isHomePage = pathname === "/";
  const shouldHide = isWaitlistMode && isHomePage;

  // All hooks must be called before any conditional returns
  useEffect(() => {
    if (!authenticated || !user?.id || user.profileImageUrl) {
      return;
    }

    const controller = new AbortController();

    const hydrateProfileImage = async () => {
      const response = await fetch(
        `/api/users/${encodeURIComponent(user.id)}/profile`,
        {
          signal: controller.signal,
        },
      ).catch((error: Error) => {
        if (error.name === "AbortError") return null;
        throw error;
      });

      if (!response || !response.ok) return;
      const data = await response.json();
      const profileUrl = data?.user?.profileImageUrl as string | undefined;
      const coverUrl = data?.user?.coverImageUrl as string | undefined;
      if (profileUrl || coverUrl) {
        setUser({
          ...user,
          profileImageUrl: profileUrl ?? user.profileImageUrl,
          coverImageUrl: coverUrl ?? user.coverImageUrl,
        });
      }
    };

    void hydrateProfileImage();

    return () => controller.abort();
  }, [
    authenticated,
    setUser,
    user?.id,
    user?.profileImageUrl,
    user?.coverImageUrl,
    user,
  ]);

  useEffect(() => {
    const fetchPoints = async () => {
      if (!authenticated || !user?.id) {
        setPointsData(null);
        return;
      }

      const token = getAuthToken();
      if (!token) {
        // No token available yet, skip fetching protected data
        return;
      }

      const headers: HeadersInit = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      // Fetch both trading balance and profile for reputation points
      const [balanceResponse, profileResponse] = await Promise.all([
        fetch(`/api/users/${encodeURIComponent(user.id)}/balance`, { headers }),
        fetch(`/api/users/${encodeURIComponent(user.id)}/profile`, { headers }),
      ]);

      if (balanceResponse.ok) {
        const balanceData = await balanceResponse.json();
        setPointsData({
          available: Number(balanceData.balance || 0),
          total: user.reputationPoints || 0, // Use reputation points from authStore as fallback
        });
      }

      // Update reputation points from profile if changed
      if (profileResponse.ok) {
        const profileData = await profileResponse.json();
        if (
          profileData.user?.reputationPoints !== undefined &&
          profileData.user.reputationPoints !== user.reputationPoints
        ) {
          setUser({
            ...user,
            reputationPoints: profileData.user.reputationPoints,
          });
          // Update local state with new reputation points
          setPointsData((prev) =>
            prev
              ? {
                  ...prev,
                  total: profileData.user.reputationPoints,
                }
              : null,
          );
        }
      }
    };

    fetchPoints();
    const interval = setInterval(fetchPoints, 30000);
    return () => clearInterval(interval);
  }, [authenticated, user?.id, user?.reputationPoints, setUser, user]);

  // Poll for unread notifications
  useEffect(() => {
    if (!authenticated || !user) {
      setUnreadNotifications(0);
      return;
    }

    const fetchUnreadCount = async () => {
      const token = getAuthToken();

      if (!token) {
        return;
      }

      const response = await fetch(
        "/api/notifications?unreadOnly=true&limit=1",
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (response.ok) {
        const data = await response.json();
        setUnreadNotifications(data.unreadCount || 0);
      }
    };

    fetchUnreadCount();

    // Refresh every 1 minute
    const interval = setInterval(fetchUnreadCount, 60000); // 60 seconds = 1 minute
    return () => clearInterval(interval);
  }, [authenticated, user]);

  const copyReferralCode = async () => {
    if (!user?.referralCode) return;

    const referralUrl = getReferralUrl(user.referralCode);
    await navigator.clipboard.writeText(referralUrl);
    setCopiedReferral(true);
    setTimeout(() => setCopiedReferral(false), 2000);
  };

  // Render nothing if should be hidden (after all hooks)
  if (shouldHide) {
    return null;
  }

  const menuItems = [
    {
      name: "Feed",
      href: "/feed",
      icon: Home,
      active: pathname === "/feed" || pathname === "/",
    },
    {
      name: "Markets",
      href: "/markets",
      icon: TrendingUp,
      active: pathname === "/markets",
    },
    {
      name: "Chats",
      href: "/chats",
      icon: MessageCircle,
      active: pathname === "/chats",
    },
    {
      name: "Leaderboards",
      href: "/leaderboard",
      icon: Trophy,
      active: pathname === "/leaderboard",
    },
    {
      name: "Rewards",
      href: "/rewards",
      icon: Gift,
      active: pathname === "/rewards",
    },
    {
      name: "Notifications",
      href: "/notifications",
      icon: Bell,
      active: pathname === "/notifications",
    },
  ];

  return (
    <>
      <header
        className={cn(
          "md:hidden",
          "fixed top-0 right-0 left-0 z-40",
          "bg-sidebar/95",
        )}
      >
        <div className="flex h-14 items-center justify-between px-4">
          {/* Left: Profile Picture (when authenticated) */}
          <div className="w-8 shrink-0">
            {authenticated && user ? (
              <button
                onClick={() => setShowSideMenu(true)}
                className="transition-opacity hover:opacity-80"
                aria-label="Open profile menu"
              >
                <Avatar
                  id={user.id}
                  name={user.displayName || user.email || "User"}
                  type="user"
                  size="sm"
                  src={user.profileImageUrl || undefined}
                  imageUrl={user.profileImageUrl || undefined}
                />
              </button>
            ) : (
              <div className="w-8" />
            )}
          </div>

          {/* Center: Logo */}
          <div className="absolute left-1/2 -translate-x-1/2 transform">
            <Link
              href="/feed"
              className="transition-transform duration-300 hover:scale-105"
            >
              <Image
                src="/assets/logos/logo.svg"
                alt="Polyagent Logo"
                width={28}
                height={28}
                className="h-7 w-7"
              />
            </Link>
          </div>

          {/* Right: Empty space for balance */}
          <div className="w-8 shrink-0" />
        </div>
      </header>

      {/* Side Menu */}
      {showSideMenu && authenticated && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm md:hidden"
            onClick={() => setShowSideMenu(false)}
          />

          {/* Menu Panel - slides in from left */}
          <div className="slide-in-from-left fixed top-0 bottom-0 left-0 z-50 flex w-[280px] animate-in flex-col bg-sidebar duration-300 md:hidden">
            {/* Header - User Profile */}
            <Link
              href="/profile"
              onClick={() => setShowSideMenu(false)}
              className="flex shrink-0 items-center justify-between p-4 transition-colors hover:bg-sidebar-accent"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Avatar
                  id={user?.id}
                  name={user?.displayName || user?.email || "User"}
                  type="user"
                  size="md"
                  src={user?.profileImageUrl || undefined}
                  imageUrl={user?.profileImageUrl || undefined}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold text-foreground text-sm">
                    {user?.displayName || user?.email || "User"}
                  </div>
                  <div className="truncate text-muted-foreground text-xs">
                    @{user?.username || `user${user?.id.slice(0, 8)}`}
                  </div>
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  setShowSideMenu(false);
                }}
                className="shrink-0 p-2 transition-colors hover:bg-muted"
              >
                <X size={20} style={{ color: "#0066FF" }} />
              </button>
            </Link>

            {/* Points Display */}
            <div className="shrink-0 bg-muted/30 px-4 py-4">
              <div className="flex items-start gap-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: "#0066FF" }}
                >
                  <Trophy className="h-5 w-5 text-foreground" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
                      Reputation
                    </div>
                    <div className="font-bold text-base text-foreground">
                      {(user?.reputationPoints || 0).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="text-muted-foreground text-xs">
                      Trading Balance
                    </div>
                    <div className="font-semibold text-foreground text-sm">
                      {(pointsData?.available || 0).toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Menu Items - Scrollable */}
            <nav className="min-h-0 flex-1 overflow-y-auto">
              {menuItems.map((item) => {
                const Icon = item.icon;
                const hasNotifications =
                  item.name === "Notifications" && unreadNotifications > 0;
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setShowSideMenu(false)}
                    className={cn(
                      "relative flex items-center gap-4 px-4 py-3 transition-colors",
                      item.active
                        ? "bg-[#0066FF] font-bold text-primary-foreground"
                        : "font-semibold text-sidebar-foreground hover:bg-sidebar-accent",
                    )}
                  >
                    <div className="relative">
                      <Icon className="h-5 w-5" />
                      {hasNotifications && (
                        <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-sidebar" />
                      )}
                    </div>
                    <span className="text-base">{item.name}</span>
                  </Link>
                );
              })}
            </nav>

            {/* Bottom Section - Referral & Logout */}
            <div className="shrink-0 border-border border-t bg-sidebar pb-20">
              {/* Referral Code Button */}
              {user?.referralCode && (
                <button
                  onClick={copyReferralCode}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left font-semibold transition-colors hover:bg-sidebar-accent"
                >
                  {copiedReferral ? (
                    <>
                      <Check className="h-5 w-5 text-green-500" />
                      <span className="text-base text-green-500">
                        Referral Link Copied!
                      </span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-5 w-5" style={{ color: "#0066FF" }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-base text-foreground">
                          Copy Referral Link
                        </div>
                        <div className="truncate font-mono text-muted-foreground text-xs">
                          {getDisplayReferralUrl(user.referralCode)}
                        </div>
                      </div>
                    </>
                  )}
                </button>
              )}

              {/* Separator */}
              {user?.referralCode && <div className="border-border border-t" />}

              {/* Logout Button */}
              <button
                onClick={() => {
                  setShowSideMenu(false);
                  logout();
                }}
                className="flex w-full items-center gap-4 px-4 py-3 text-left font-semibold text-destructive transition-colors hover:bg-destructive/10"
              >
                <LogOut className="h-5 w-5" />
                <span className="text-base">Logout</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Mobile header component for mobile devices.
 *
 * Provides a fixed header with logo, profile menu trigger, and slide-out
 * side menu. Automatically hides when WAITLIST_MODE is enabled on home page.
 *
 * @returns Mobile header element or null if hidden
 */
export function MobileHeader() {
  return <MobileHeaderContent />;
}
