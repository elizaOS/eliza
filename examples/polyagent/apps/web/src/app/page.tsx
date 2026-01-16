'use client';

import {
  Bot,
  ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LoginButton } from '@/components/auth/LoginButton';
import { PageContainer } from '@/components/shared/PageContainer';
import { useAuth } from '@/hooks/useAuth';

function UnauthenticatedView() {
  return (
    <PageContainer noPadding className="flex flex-col">
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="w-full max-w-3xl text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center border border-border bg-muted">
            <Bot className="h-8 w-8 text-foreground" />
          </div>
          <h1 className="mb-3 font-semibold text-3xl text-foreground">
            Polyagent
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-base text-muted-foreground">
            Build autonomous agents that trade on Polymarket. Create, fund, and
            manage trading agents from one focused workspace.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <LoginButton size="lg" />
            <Link
              href="/agents"
              className="inline-flex items-center gap-2 border border-border px-4 py-2 text-foreground"
            >
              View Agents
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-10 grid gap-4 text-left sm:grid-cols-3">
            <div className="border border-border p-4">
              <Bot className="mb-2 h-5 w-5 text-foreground" />
              <h3 className="font-semibold text-sm">Create Agents</h3>
              <p className="text-muted-foreground text-xs">
                Define strategies and deploy new trading agents.
              </p>
            </div>
            <div className="border border-border p-4">
              <Wallet className="mb-2 h-5 w-5 text-foreground" />
              <h3 className="font-semibold text-sm">Fund Wallets</h3>
              <p className="text-muted-foreground text-xs">
                Allocate capital to power agent trades.
              </p>
            </div>
            <div className="border border-border p-4">
              <TrendingUp className="mb-2 h-5 w-5 text-foreground" />
              <h3 className="font-semibold text-sm">Track Performance</h3>
              <p className="text-muted-foreground text-xs">
                Monitor positions, P&L, and agent activity.
              </p>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

export default function HomePage() {
  const { ready, authenticated } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (authenticated) {
      router.replace('/agents');
    }
  }, [authenticated, router]);

  if (!ready) {
    return (
      <PageContainer>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </PageContainer>
    );
  }

  if (!authenticated) {
    return <UnauthenticatedView />;
  }
  return (
    <PageContainer>
      <div className="flex min-h-[60vh] items-center justify-center">
        <Link
          href="/agents"
          className="inline-flex items-center gap-2 border border-border bg-primary px-5 py-3 font-medium text-primary-foreground"
        >
          Go to Agents
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </PageContainer>
  );
}
