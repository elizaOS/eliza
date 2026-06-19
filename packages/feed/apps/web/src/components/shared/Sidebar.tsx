"use client";

import { cn, extractErrorMessage, getReferralUrl, logger } from "@feed/shared";
import {
  Bell,
  Bot,
  Check,
  ChevronsRight,
  Copy,
  LogOut,
  MessageCircle,
  Shield,
  TrendingUp,
  Trophy,
  User,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoginButton } from "@/components/auth/LoginButton";
import { UserMenu } from "@/components/auth/UserMenu";
import { GameFeedbackModal } from "@/components/feedback/GameFeedbackModal";
import { Avatar } from "@/components/shared/Avatar";
import { FeedIcon } from "@/components/shared/icons/FeedIcon";
import { FeedFullLogo } from "@/components/shared/icons/FeedLogo";
import { HouseIcon } from "@/components/shared/icons/HouseIcon";
import { useEmbedMode } from "@/contexts/EmbedContext";
import { useAuth } from "@/hooks/useAuth";
import { usePostHog } from "@/hooks/usePostHog";
import { useUnreadMessages } from "@/hooks/useUnreadMessages";
import { useUnreadNotifications } from "@/hooks/useUnreadNotifications";
import { getUserDisplayName } from "@/lib/user-display";

/**
 * Main sidebar content component with navigation and user menu.
 *
 * Provides navigation links, user authentication state, unread message
 * counts, and admin access. Handles responsive behavior. Includes referral
 * code sharing functionality.
 *
 * @returns Sidebar content element
 */
function SidebarContent() {
  const [collapsed, setCollapsed] = useState(false);
  const [showMdMenu, setShowMdMenu] = useState(false);
  const [copiedReferral, setCopiedReferral] = useState(false);
  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const mdMenuRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const { ready, authenticated, user, logout, login, refresh } = useAuth();
  const { trackNavigation } = usePostHog();
  const { totalUnread: unreadMessages } = useUnreadMessages();
  const { unreadCount: unreadNotifications } = useUnreadNotifications();

  // Portfolio data for points display above user menu
  const [livePortfolio, setLivePortfolio] = useState<{
    reputationPoints: number;
    wallet: number;
  } | null>(null);

  const fetchPortfolio = useCallback(async () => {
    if (!user?.id) return;
    try {
      const res = await fetch(
        `/api/users/${encodeURIComponent(user.id)}/portfolio-breakdown`,
      );
      if (res.ok) {
        const data = await res.json();
        setLivePortfolio({
          reputationPoints: data.reputationPoints ?? 0,
          wallet: data.wallet ?? 0,
        });
      }
    } catch {
      // Silently fail — will show fallback values
    }
  }, [user?.id]);

  useEffect(() => {
    fetchPortfolio();
  }, [fetchPortfolio]);

  // Listen for rewards-updated events to refresh points
  useEffect(() => {
    const handleRewardsUpdated = () => {
      void fetchPortfolio();
      void refresh().catch((error) => {
        logger.warn(
          "Failed to refresh auth state after rewards update",
          { error: extractErrorMessage(error) },
          "Sidebar",
        );
      });
    };
    window.addEventListener("rewards-updated", handleRewardsUpdated);
    return () => {
      window.removeEventListener("rewards-updated", handleRewardsUpdated);
    };
  }, [fetchPortfolio, refresh]);

  // Hide sidebar when WAITLIST_MODE is enabled on home page, or in embed mode
  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === "true";
  const isHomePage = pathname === "/";
  const { isEmbedded } = useEmbedMode();
  const shouldHideSidebar = isEmbedded || (isWaitlistMode && isHomePage);

  // Check if user is admin from the user object
  const isAdmin = user?.isAdmin ?? false;

  // All hooks must be called before any conditional returns
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        mdMenuRef.current &&
        !mdMenuRef.current.contains(event.target as Node)
      ) {
        setShowMdMenu(false);
      }
    };

    if (showMdMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
    return undefined;
  }, [showMdMenu]);

  // Adjust sidebar height to account for any shell content above it so the
  // user profile bar at the bottom is always visible.
  useEffect(() => {
    let rafId: number;
    const updateHeight = () => {
      rafId = requestAnimationFrame(() => {
        if (!asideRef.current) return;
        const top = Math.max(0, asideRef.current.getBoundingClientRect().top);
        asideRef.current.style.height = `calc(100vh - ${top}px)`;
      });
    };
    updateHeight();
    window.addEventListener("scroll", updateHeight, { passive: true });
    window.addEventListener("resize", updateHeight, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("scroll", updateHeight);
      window.removeEventListener("resize", updateHeight);
    };
  }, []);

  const copyReferralCode = async () => {
    if (!user?.referralCode) return;

    const referralUrl = getReferralUrl(user.referralCode);
    await navigator.clipboard.writeText(referralUrl);
    setCopiedReferral(true);
    setTimeout(() => setCopiedReferral(false), 2000);
  };

  // Render nothing if sidebar should be hidden (after all hooks)
  if (shouldHideSidebar) {
    return null;
  }

  const navItems = [
    {
      name: "Home",
      href: "/feed",
      icon: HouseIcon,
      active: pathname === "/feed" || pathname === "/",
    },
    {
      name: "Agents",
      href: "/agents/team",
      icon: Bot,
      active: pathname === "/agents" || pathname.startsWith("/agents/"),
      requiresAuth: true,
    },
    {
      name: "Markets",
      href: "/markets",
      icon: TrendingUp,
      active:
        pathname.startsWith("/markets") ||
        pathname === "/markets" ||
        pathname.startsWith("/markets/perps/") ||
        pathname.startsWith("/markets/predictions/"),
    },
    {
      name: "Chats",
      href: "/chats",
      icon: MessageCircle,
      active: pathname === "/chats",
      requiresAuth: true,
    },
    {
      name: "Wallet",
      href: "/wallet",
      icon: Wallet,
      active: pathname === "/wallet",
      requiresAuth: true,
    },
    {
      name: "Points",
      href: "/leaderboard",
      icon: Trophy,
      active: pathname === "/leaderboard" || pathname === "/rewards",
    },
    {
      name: "Notifications",
      href: "/notifications",
      icon: Bell,
      active: pathname === "/notifications",
      requiresAuth: true,
    },
    {
      name: "Profile",
      href: "/profile",
      icon: User,
      active: pathname === "/profile" || pathname.startsWith("/u/"),
      requiresAuth: true,
    },
    // Admin link (only shown for admins)
    ...(isAdmin
      ? [
          {
            name: "Admin",
            href: "/admin",
            icon: Shield,
            active: pathname === "/admin",
          },
        ]
      : []),
  ];

  return (
    <>
      {/* Responsive sidebar: icons only on tablet (md), icons + names on desktop (lg+) */}
      <aside
        ref={asideRef}
        className={cn(
          "sticky top-0 isolate z-40 hidden h-screen md:flex md:flex-col",
          "bg-sidebar",
          "transition-all duration-300",
          "md:w-20",
          "mx-2",
          !collapsed && "lg:w-48",
        )}
      >
        {/* Header - Logo & Collapse Toggle */}
        <div
          className={cn(
            "flex items-center justify-center p-6",
            !collapsed && "lg:justify-start lg:px-4",
          )}
        >
          <Link href="/feed" aria-label="Feed home">
            {/* Icon-only logo for md (tablet) or collapsed */}
            <FeedIcon
              className={cn(
                "h-8 w-8 text-sidebar-primary",
                !collapsed && "lg:hidden",
              )}
            />
            {/* Full logo with text for lg+ (desktop) when expanded */}
            {!collapsed && (
              <FeedFullLogo className="hidden h-8 w-auto text-sidebar-primary lg:block" />
            )}
          </Link>
        </div>
        {/* Expand toggle - only visible on lg+ when collapsed, styled like nav items */}
        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="hidden w-full items-center justify-center px-4 py-3 text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-black lg:flex dark:hover:text-white"
            aria-label="Expand sidebar"
          >
            <ChevronsRight className="h-6 w-6" />
          </button>
        )}

        {/* Navigation - scrollable when screen is short */}
        <nav className="pointer-events-auto relative z-20 flex-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const hasNotificationBadge =
              (Icon === Bell && unreadNotifications > 0) ||
              (Icon === MessageCircle && unreadMessages > 0);

            const navContent = (
              <>
                {/* Icon with notification indicator */}
                <div className={cn("relative", !collapsed && "lg:mr-3")}>
                  <Icon
                    className={cn(
                      "h-6 w-6 flex-shrink-0",
                      item.active
                        ? "text-sidebar-primary"
                        : "text-sidebar-foreground",
                    )}
                  />
                  {hasNotificationBadge && (
                    <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-sidebar" />
                  )}
                </div>

                {/* Label - hidden on tablet (md), shown on desktop (lg+) */}
                <span
                  className={cn(
                    "hidden",
                    !collapsed && "lg:block",
                    "text-lg transition-colors duration-300",
                    item.active
                      ? "font-semibold text-black dark:text-white"
                      : "text-sidebar-foreground group-hover:text-black dark:group-hover:text-white",
                  )}
                >
                  {item.name}
                </span>
              </>
            );

            const sharedClassName = cn(
              "group pointer-events-auto relative z-10 flex items-center px-4 py-3",
              "transition-colors duration-200",
              "md:justify-center",
              !collapsed && "lg:justify-start",
              "bg-transparent hover:bg-sidebar-accent",
            );

            if (item.requiresAuth && !authenticated) {
              return (
                <button
                  key={item.name}
                  type="button"
                  onClick={login}
                  className={cn(sharedClassName, "w-full")}
                  title={item.name}
                  {...(item.name === "Agents"
                    ? { "data-tour": "sidebar-agents" }
                    : {})}
                >
                  {navContent}
                </button>
              );
            }

            return (
              <Link
                key={item.name}
                href={item.href}
                prefetch={true}
                className={sharedClassName}
                title={item.name}
                onClick={() => trackNavigation(item.href, "sidebar")}
                {...(item.name === "Agents"
                  ? { "data-tour": "sidebar-agents" }
                  : {})}
              >
                {navContent}
              </Link>
            );
          })}
        </nav>

        {/* Bottom Section - Authentication (Desktop lg+) */}
        <div className={cn("hidden", !collapsed && "lg:block")}>
          {!ready ? (
            // Skeleton loader while authentication is initializing
            <div className="flex animate-pulse items-center gap-3 p-3">
              <div className="h-10 w-10 rounded-full bg-sidebar-accent/50" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-24 rounded bg-sidebar-accent/50" />
                <div className="h-3 w-16 rounded bg-sidebar-accent/30" />
              </div>
            </div>
          ) : authenticated ? (
            <>
              {/* Points Display - always visible above user menu */}
              <div className="border-sidebar-accent border-t px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-sm">
                    Total Points
                  </span>
                  <span className="font-semibold text-sidebar-foreground">
                    {(
                      livePortfolio?.reputationPoints ??
                      user?.reputationPoints ??
                      0
                    ).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-muted-foreground text-xs">
                    Trading Balance
                  </span>
                  <span className="text-sidebar-foreground text-sm">
                    {(livePortfolio?.wallet ?? 0).toLocaleString()}
                  </span>
                </div>
              </div>
              <UserMenu />
            </>
          ) : (
            <LoginButton />
          )}
        </div>

        {/* Bottom Section - User Icon (Tablet md) */}
        {authenticated && user && (
          <div
            className={cn("relative md:block", !collapsed && "lg:hidden")}
            ref={mdMenuRef}
          >
            {/* User avatar button - styled like nav items */}
            <button
              onClick={() => setShowMdMenu(!showMdMenu)}
              className="flex w-full items-center justify-center px-4 py-3 transition-colors duration-200 hover:bg-sidebar-accent"
              aria-label="Open user menu"
            >
              <Avatar
                id={user.id}
                name={getUserDisplayName(user, "User")}
                type="user"
                size="sm"
                src={user.profileImageUrl || undefined}
                imageUrl={user.profileImageUrl || undefined}
              />
            </button>

            {/* Dropdown Menu - styled like nav items */}
            {showMdMenu && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden bg-sidebar shadow-lg">
                {/* Referral Code */}
                {user.referralCode && (
                  <button
                    onClick={copyReferralCode}
                    className="flex w-full items-center justify-center px-4 py-3 transition-colors duration-200 hover:bg-sidebar-accent"
                    title={copiedReferral ? "Copied!" : "Copy Referral Link"}
                    aria-label={
                      copiedReferral ? "Copied!" : "Copy Referral Link"
                    }
                  >
                    {copiedReferral ? (
                      <Check className="h-6 w-6 flex-shrink-0 text-green-500" />
                    ) : (
                      <Copy className="h-6 w-6 flex-shrink-0 text-sidebar-foreground" />
                    )}
                  </button>
                )}

                {/* Logout */}
                <button
                  onClick={() => {
                    setShowMdMenu(false);
                    logout();
                  }}
                  className="flex w-full items-center justify-center px-4 py-3 text-destructive transition-colors duration-200 hover:bg-sidebar-accent"
                  title="Logout"
                  aria-label="Logout"
                >
                  <LogOut className="h-6 w-6 flex-shrink-0" />
                </button>
              </div>
            )}
          </div>
        )}

        <GameFeedbackModal
          isOpen={feedbackModalOpen}
          onClose={() => setFeedbackModalOpen(false)}
        />
      </aside>
    </>
  );
}

/**
 * Sidebar component with navigation and user menu.
 *
 * Provides navigation links, user authentication state, unread message
 * counts, and admin access. Automatically hides when WAITLIST_MODE is
 * enabled on home page.
 *
 * @returns Sidebar element or null if hidden
 */
export function Sidebar() {
  return <SidebarContent />;
}
