'use client';

import { cn } from '@babylon/shared';
import { Bot, MessageCircle, TrendingUp, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { HouseIcon } from '@/components/shared/icons/HouseIcon';
import { useEmbedMode } from '@/contexts/EmbedContext';
import { usePostHog } from '@/hooks/usePostHog';
import { useUnreadMessages } from '@/hooks/useUnreadMessages';

/**
 * Bottom navigation content component for mobile devices.
 *
 * Provides mobile navigation with Feed, Terminal, Chats, Agents, and Notifications tabs.
 * Shows unread message and notification badges. Automatically hides when WAITLIST_MODE
 * is enabled on home page.
 *
 * @returns Bottom navigation element or null if hidden
 */
function BottomNavContent() {
  const pathname = usePathname();
  const { trackNavigation } = usePostHog();
  const { totalUnread: unreadMessages } = useUnreadMessages();

  // Hide bottom nav when embedded or WAITLIST_MODE on home page
  const isWaitlistMode = process.env.NEXT_PUBLIC_WAITLIST_MODE === 'true';
  const isHomePage = pathname === '/';
  const { isEmbedded } = useEmbedMode();
  const shouldHide = isEmbedded || (isWaitlistMode && isHomePage);

  // Hide when virtual keyboard is open (interactiveWidget: 'resizes-content'
  // shrinks the layout viewport, pushing the fixed nav up with the keyboard).
  // Also sets --bottom-nav-height CSS variable so page height calcs (e.g.
  // h-[calc(100dvh-56px-var(--bottom-nav-height))]) and main pb-[--bottom-nav-height] adjust too.
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let fullHeight = vv.height;
    const onResize = () => {
      if (vv.height > fullHeight) fullHeight = vv.height;
      const open = fullHeight - vv.height > 150;
      setKeyboardOpen(open);
      document.documentElement.style.setProperty(
        '--bottom-nav-height',
        open ? '0px' : '56px'
      );
    };

    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // If should be hidden, don't render anything
  if (shouldHide) {
    return null;
  }

  const navItems = [
    {
      name: 'Home',
      href: '/feed',
      icon: HouseIcon,
      color: '#0066FF',
      active: pathname === '/feed' || pathname === '/',
    },
    {
      name: 'Agents',
      href: '/agents/team',
      icon: Bot,
      color: '#0066FF',
      active: pathname === '/agents' || pathname.startsWith('/agents/'),
    },
    {
      name: 'Markets',
      href: '/markets',
      icon: TrendingUp,
      color: '#0066FF',
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
      color: '#0066FF',
      active: pathname === '/chats',
    },
    {
      name: 'Wallet',
      href: '/wallet',
      icon: Wallet,
      color: '#0066FF',
      active: pathname === '/wallet',
    },
  ];

  return (
    <nav
      id="app-bottom-nav"
      data-bottom-nav
      className={cn(
        'fixed right-0 bottom-0 bottom-nav-rounded left-0 z-50 border-border border-t bg-sidebar md:hidden',
        keyboardOpen && 'hidden'
      )}
    >
      {/* Navigation Items */}
      <div className="safe-area-bottom flex h-14 items-center justify-between px-4">
        <div className="flex flex-1 items-center justify-around">
          {navItems.map((item) => {
            const Icon = item.icon;
            const hasNotificationBadge =
              Icon === MessageCircle && unreadMessages > 0;
            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={() => trackNavigation(item.href, 'bottom_nav')}
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-lg transition-colors duration-200',
                  'hover:bg-sidebar-accent/50',
                  'relative'
                )}
                aria-label={item.name}
              >
                <Icon
                  className={cn(
                    'h-6 w-6 transition-colors duration-200',
                    item.active
                      ? 'text-sidebar-primary'
                      : 'text-sidebar-foreground'
                  )}
                  style={{
                    color: item.active ? item.color : undefined,
                  }}
                  fill={item.active ? 'currentColor' : 'none'}
                />
                {hasNotificationBadge && (
                  <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-sidebar" />
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

/**
 * Bottom navigation component for mobile devices.
 *
 * Provides mobile navigation with Feed, Terminal, Chats, Agents, and Notifications tabs.
 * Shows unread message and notification badges. Automatically hides when WAITLIST_MODE
 * is enabled on home page.
 *
 * @returns Bottom navigation element or null if hidden
 */
export function BottomNav() {
  return <BottomNavContent />;
}
