'use client';

import { getReferralUrl } from '@babylon/shared';
import { Check, Copy, ExternalLink, Trophy, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getAuthToken } from '@/lib/auth';
import { useAuthStore } from '@/stores/authStore';
import { apiUrl } from '@/utils/api-url';

/**
 * Invite friends banner component for referral program.
 *
 * Displays a banner encouraging users to invite friends and earn referral
 * rewards. Shows referral code, copy functionality, and tracks banner views
 * and dismissals. Links to rewards page for more details.
 *
 * @param props - InviteFriendsBanner component props
 * @returns Invite friends banner element or null if no referral code
 *
 * @example
 * ```tsx
 * <InviteFriendsBanner onDismiss={() => console.log('dismissed')} />
 * ```
 */
interface InviteFriendsBannerProps {
  onDismiss?: () => void;
}

export function InviteFriendsBanner({ onDismiss }: InviteFriendsBannerProps) {
  const { user, setUser } = useAuthStore();
  const [copiedReferral, setCopiedReferral] = useState(false);

  useEffect(() => {
    const trackBannerView = async () => {
      if (!user?.id) return;

      const token = getAuthToken();
      if (!token) return;

      // Track banner view in local storage
      const viewKey = `banner_view_${user.id}`;
      const lastView = localStorage.getItem(viewKey);
      const now = Date.now();

      // Store this view
      localStorage.setItem(viewKey, now.toString());

      // Update server if more than 1 day since last tracked
      if (!lastView || now - parseInt(lastView) > 86400000) {
        await fetch(
          `/api/users/${encodeURIComponent(user.id)}/update-profile`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              bannerLastShown: new Date().toISOString(),
            }),
          }
        );
      }
    };

    trackBannerView();
  }, [user]);

  const handleCopyReferral = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!user?.referralCode) return;
    const referralUrl = getReferralUrl(user.referralCode);
    await navigator.clipboard.writeText(referralUrl);
    setCopiedReferral(true);
    setTimeout(() => setCopiedReferral(false), 2000);
  };

  const handleDismiss = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!user?.id) return;

    // Track dismiss in local storage
    const dismissKey = `banner_dismiss_${user.id}`;
    const dismissCount = parseInt(localStorage.getItem(dismissKey) || '0');
    localStorage.setItem(dismissKey, (dismissCount + 1).toString());
    localStorage.setItem(
      `banner_dismiss_time_${user.id}`,
      Date.now().toString()
    );

    // Update server
    const token = getAuthToken();
    if (token) {
      await fetch(
        apiUrl(`/api/users/${encodeURIComponent(user.id)}/update-profile`),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            bannerDismissCount: dismissCount + 1,
          }),
        }
      );

      // Update local user state
      if (user) {
        setUser({
          ...user,
          bannerDismissCount: dismissCount + 1,
        });
      }
    }

    // Call parent dismiss handler
    onDismiss?.();
  };

  if (!user?.referralCode) {
    return null;
  }

  return (
    <Link
      href="/rewards"
      className="group block border-border border-b transition-colors hover:bg-muted/30"
    >
      <div className="mx-auto max-w-feed p-4">
        <div className="relative rounded-xl border border-purple-500/20 bg-gradient-to-br from-purple-500/10 to-pink-500/10 p-4 transition-colors hover:border-purple-500/40">
          {/* Dismiss button */}
          <button
            onClick={handleDismiss}
            className="absolute top-2 right-2 rounded-full p-1 opacity-0 transition-colors hover:bg-background/50 group-hover:opacity-100"
            title="Dismiss"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>

          <div className="mb-2 flex items-center gap-2">
            <Trophy className="h-5 w-5 text-purple-500" />
            <h3 className="font-semibold text-foreground">Invite Friends</h3>
            <span className="ml-auto rounded bg-green-500/10 px-2 py-1 text-green-500 text-xs">
              50% of fees
            </span>
          </div>
          <p className="mb-3 text-muted-foreground text-sm">
            Earn 50% of all trading fees from your referrals!
          </p>
          <div className="flex items-center justify-between">
            <button
              onClick={handleCopyReferral}
              className="flex items-center gap-2 rounded-lg bg-sidebar-accent px-3 py-2 text-foreground transition-colors hover:bg-sidebar-accent/70"
            >
              {copiedReferral ? (
                <>
                  <Check className="h-4 w-4 text-green-500" />
                  <span className="text-sm">Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  <span className="text-sm">Copy Link</span>
                </>
              )}
            </button>
            <span className="flex items-center gap-1 text-purple-500 text-sm group-hover:text-purple-400">
              View All
              <ExternalLink className="h-4 w-4" />
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}
