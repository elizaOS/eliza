'use client';

export const dynamic = 'force-dynamic';

import nextDynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LoginButton } from '@/components/auth/LoginButton';
import { PageContainer } from '@/components/shared/PageContainer';
import { BalanceTab } from '@/components/wallet/v2/balance-tab';
import { PnLTab } from '@/components/wallet/v2/pnl-tab';
import { PositionsTab } from '@/components/wallet/v2/positions-tab';
import { useAuth } from '@/hooks/useAuth';
import { useTeamTradingSummary } from '@/hooks/useTeamTradingSummary';
import { useUserPositionsPolling } from '@/stores/userPositionsStore';
import {
  invalidateWalletBalance,
  useWalletBalancePolling,
} from '@/stores/walletBalanceStore';

const BuyPointsModal = nextDynamic(
  () =>
    import('@/components/points/BuyPointsModal').then((m) => ({
      default: m.BuyPointsModal,
    })),
  { ssr: false }
);

export default function WalletPage() {
  const router = useRouter();
  const { ready, authenticated, getAccessToken, login, user } = useAuth();
  const [showBuyPoints, setShowBuyPoints] = useState(false);

  const userId = authenticated ? user?.id : undefined;

  // Start polling for wallet data when authenticated
  useWalletBalancePolling(userId ?? null, 15_000);
  useUserPositionsPolling(userId ?? null);

  const {
    summary: teamSummary,
    loading: teamSummaryLoading,
    error: teamSummaryError,
  } = useTeamTradingSummary({
    enabled: Boolean(ready && authenticated && userId),
    getAccessToken,
  });

  // Redirect unauthenticated users
  useEffect(() => {
    if (!ready || authenticated) return;
    router.push('/feed');
    const timer = setTimeout(() => login(), 500);
    return () => clearTimeout(timer);
  }, [ready, authenticated, router, login]);

  if (!ready) {
    return <WalletPageSkeleton />;
  }

  if (!authenticated || !userId) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <p className="text-muted-foreground text-sm">
            Log in to view your portfolio
          </p>
          <LoginButton />
        </div>
      </div>
    );
  }

  return (
    <PageContainer noPadding className="flex w-full flex-col pt-14 md:pt-0">
      <div className="relative flex flex-1">
        {/* Main wallet content — single scrollable view */}
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          <div className="space-y-6 p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:space-y-8 md:p-6 md:pb-6">
            {/* Balance section */}
            <BalanceTab
              userId={userId}
              onBuyPoints={() => setShowBuyPoints(true)}
            />

            {/* P&L section */}
            <PnLTab
              userId={userId}
              teamSummary={teamSummary}
              teamSummaryLoading={teamSummaryLoading}
              teamSummaryError={teamSummaryError}
            />
          </div>
        </div>

        {/* Right sidebar — Positions */}
        <div className="hidden w-96 flex-none flex-col border-border border-l xl:flex">
          <div className="sticky top-0 p-4">
            <PositionsTab userId={userId} />
          </div>
        </div>

        {/* Mobile: positions below main content are handled by the scrollable layout */}
        <div className="xl:hidden">
          {/* On smaller screens, positions appear inline at bottom of main scroll */}
        </div>
      </div>

      {showBuyPoints && (
        <BuyPointsModal
          isOpen={showBuyPoints}
          onClose={() => setShowBuyPoints(false)}
          onSuccess={() => {
            invalidateWalletBalance();
            window.dispatchEvent(new CustomEvent('rewards-updated'));
          }}
        />
      )}
    </PageContainer>
  );
}

function WalletPageSkeleton() {
  return (
    <PageContainer noPadding className="flex w-full flex-col pt-14 md:pt-0">
      <div className="relative flex flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          <div className="space-y-6 p-6">
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-16 animate-pulse rounded-xl bg-muted" />
              <div className="h-16 animate-pulse rounded-xl bg-muted" />
            </div>
            <div className="h-40 animate-pulse rounded-xl bg-muted" />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-muted" />
              ))}
            </div>
          </div>
        </div>
        <div className="hidden w-96 flex-none xl:block" />
      </div>
    </PageContainer>
  );
}
