'use client';

import { cn, getDisplayReferralUrl, getReferralUrl } from '@babylon/shared';
import {
  Bell,
  Bot,
  Check,
  Copy,
  Gift,
  LogOut,
  MessageCircle,
  Settings,
  TrendingUp,
  Trophy,
  User,
  Wallet,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GameFeedbackModal } from '@/components/feedback/GameFeedbackModal';
import { Avatar } from '@/components/shared/Avatar';
import { BabylonIcon } from '@/components/shared/icons/BabylonIcon';
import { HouseIcon } from '@/components/shared/icons/HouseIcon';
import {
  fetchMobileHeaderPointsSnapshot,
  isAbortError,
} from '@/components/shared/mobileHeaderPoints';
import { useEmbedMode } from '@/contexts/EmbedContext';
import { useAuth } from '@/hooks/useAuth';
import { useUnreadMessages } from '@/hooks/useUnreadMessages';
import { useUnreadNotifications } from '@/hooks/useUnreadNotifications';
import { getAuthToken } from '@/lib/auth';
import { useAuthStore } from '@/stores/authStore';

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
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const pathname = usePathname();
  const { totalUnread: unreadMessages } = useUnreadMessages();
  const { unreadCount: unreadNotifications } = useUnreadNotifications();

  // Hide mobile header when embedded or WAITLIST_MODE on home page
  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === 'true';
  const isHomePage = pathname === '/';
  const { isEmbedded } = useEmbedMode();
  const shouldHide = isEmbedded || (isWaitlistMode && isHomePage);

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
        }
      ).catch((error: Error) => {
        if (error.name === 'AbortError') return null;
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
    let activeController: AbortController | null = null;

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

      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      try {
        const snapshot = await fetchMobileHeaderPointsSnapshot({
          userId: user.id,
          token,
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        if (snapshot.available !== null) {
          setPointsData({
            available: snapshot.available,
            total: snapshot.reputationPoints ?? user.reputationPoints ?? 0,
          });
        } else if (snapshot.reputationPoints !== null) {
          setPointsData((prev) =>
            prev
              ? {
                  ...prev,
                  total: snapshot.reputationPoints ?? prev.total,
                }
              : null
          );
        }

        if (
          snapshot.reputationPoints !== null &&
          snapshot.reputationPoints !== user.reputationPoints
        ) {
          setUser({
            ...user,
            reputationPoints: snapshot.reputationPoints,
          });
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
      }
    };

    void fetchPoints();
    const interval = setInterval(fetchPoints, 30000);
    return () => {
      clearInterval(interval);
      activeController?.abort();
    };
  }, [authenticated, user?.id, user?.reputationPoints, setUser, user]);

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
      name: 'Home',
      href: '/feed',
      icon: HouseIcon,
      active: pathname === '/feed' || pathname === '/',
    },
    {
      name: 'Agents',
      href: '/agents/team',
      icon: Bot,
      active: pathname === '/agents' || pathname.startsWith('/agents/'),
    },
    {
      name: 'Markets',
      href: '/markets',
      icon: TrendingUp,
      active:
        pathname.startsWith('/markets') ||
        pathname === '/markets' ||
        pathname.startsWith('/markets/perps/') ||
        pathname.startsWith('/markets/predictions/'),
    },
    {
      name: 'Chats',
      href: '/chats',
      icon: MessageCircle,
      active: pathname === '/chats',
    },
    {
      name: 'Wallet',
      href: '/wallet',
      icon: Wallet,
      active: pathname === '/wallet',
    },
    {
      name: 'Leaderboard',
      href: '/leaderboard',
      icon: Trophy,
      active: pathname === '/leaderboard',
    },
    {
      name: 'Rewards',
      href: '/rewards',
      icon: Gift,
      active: pathname === '/rewards',
    },
    {
      name: 'Notifications',
      href: '/notifications',
      icon: Bell,
      active: pathname === '/notifications',
    },
    {
      name: 'Profile',
      href: '/profile',
      icon: User,
      active: pathname === '/profile' || pathname.startsWith('/u/'),
    },
    {
      name: 'Settings',
      href: '/settings',
      icon: Settings,
      active: pathname?.startsWith('/settings'),
    },
  ];

  return (
    <>
      <header
        className={cn(
          'md:hidden',
          'fixed top-0 right-0 left-0 z-40',
          'bg-sidebar/95'
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
                  name={user.displayName || user.email || 'User'}
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
              <BabylonIcon className="h-7 w-7 text-primary" />
            </Link>
          </div>
        </div>
      </header>

      {/* Side Menu */}
      {showSideMenu && authenticated && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-50 bg-neutral-300/70 backdrop-blur-[3px] md:hidden dark:bg-neutral-900/70"
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
                  name={user?.displayName || user?.email || 'User'}
                  type="user"
                  size="md"
                  src={user?.profileImageUrl || undefined}
                  imageUrl={user?.profileImageUrl || undefined}
                  className="shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold text-foreground text-sm">
                    {user?.displayName || user?.email || 'User'}
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
                <X size={20} style={{ color: '#0066FF' }} />
              </button>
            </Link>

            {/* Points Display */}
            <div className="shrink-0 border-border border-b px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="text-muted-foreground text-xs">Reputation</div>
                <div className="font-bold text-foreground text-sm">
                  {(user?.reputationPoints || 0).toLocaleString()}
                </div>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <div className="text-muted-foreground text-xs">
                  Trading Balance
                </div>
                <div className="font-bold text-foreground text-sm">
                  {(pointsData?.available || 0).toLocaleString()}
                </div>
              </div>
            </div>

            {/* Menu Items - Scrollable */}
            <nav className="min-h-0 flex-1 overflow-y-auto pt-2.5">
              {menuItems.map((item) => {
                const Icon = item.icon;
                const hasNotificationBadge =
                  (Icon === Bell && unreadNotifications > 0) ||
                  (Icon === MessageCircle && unreadMessages > 0);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    onClick={() => setShowSideMenu(false)}
                    className={cn(
                      'relative flex items-center gap-4 px-4 py-2.5 transition-colors',
                      item.active
                        ? 'bg-[#0066FF] font-bold text-primary-foreground'
                        : 'font-semibold text-sidebar-foreground hover:bg-sidebar-accent'
                    )}
                  >
                    <div className="relative">
                      <Icon className="h-5 w-5" />
                      {hasNotificationBadge && (
                        <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-sidebar" />
                      )}
                    </div>
                    <span className="text-base">{item.name}</span>
                  </Link>
                );
              })}
            </nav>

            {/* Bottom Section - Referral & Logout */}
            <div className="shrink-0 border-border border-t bg-sidebar pb-16">
              {/* Referral Code Button */}
              {user?.referralCode && (
                <button
                  onClick={copyReferralCode}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left font-semibold transition-colors hover:bg-sidebar-accent"
                >
                  {copiedReferral ? (
                    <>
                      <Check className="h-5 w-5 text-green-500" />
                      <div className="min-w-0 flex-1">
                        <div className="text-base text-green-500">
                          Referral Link Copied!
                        </div>
                        <div className="truncate font-mono text-muted-foreground text-xs">
                          {getDisplayReferralUrl(user.referralCode)}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <Copy className="h-5 w-5" style={{ color: '#0066FF' }} />
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

      {/* Feedback Modal */}
      <GameFeedbackModal
        isOpen={showFeedbackModal}
        onClose={() => setShowFeedbackModal(false)}
      />
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
