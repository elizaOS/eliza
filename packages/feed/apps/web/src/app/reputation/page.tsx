'use client';

export const dynamic = 'force-dynamic';

import { IDENTITY_REGISTRY_BASE_SEPOLIA } from '@babylon/shared';
import { Award, Medal, Target, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageContainer } from '@/components/shared/PageContainer';
import { useAuth } from '@/hooks/useAuth';
import { apiUrl } from '@/utils/api-url';

interface ReputationStats {
  currentReputation: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  averageGameScore: number;
  averageFeedbackScore: number;
  totalFeedbackReceived: number;
  trustLevel: string;
}

const emptyStats: ReputationStats = {
  currentReputation: 0,
  totalWins: 0,
  totalLosses: 0,
  winRate: 0,
  averageGameScore: 0,
  averageFeedbackScore: 0,
  totalFeedbackReceived: 0,
  trustLevel: 'UNRATED',
};

export default function ReputationPage() {
  const { user, authenticated } = useAuth();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<ReputationStats>(emptyStats);

  useEffect(() => {
    if (!authenticated || !user) {
      setLoading(false);
      return;
    }

    const fetchReputation = async () => {
      setLoading(true);
      const response = await fetch(
        apiUrl(`/api/reputation/${encodeURIComponent(user.id)}`)
      );
      if (!response.ok) {
        setStats(emptyStats);
        setLoading(false);
        return;
      }

      const data = await response.json();
      const gamesPlayed = data.performance?.gamesPlayed ?? 0;
      const gamesWon = data.performance?.gamesWon ?? 0;
      const wins = Math.max(0, gamesWon);
      const losses = Math.max(0, gamesPlayed - gamesWon);

      setStats({
        currentReputation: Math.round(data.reputationPoints ?? 0),
        totalWins: wins,
        totalLosses: losses,
        winRate: (data.performance?.winRate ?? 0) * 100,
        averageGameScore: data.performance?.averageGameScore ?? 0,
        averageFeedbackScore: data.averageFeedbackScore ?? 0,
        totalFeedbackReceived: data.totalFeedbackReceived ?? 0,
        trustLevel: data.trustLevel ?? 'UNRATED',
      });
      setLoading(false);
    };

    void fetchReputation();

    const interval = setInterval(fetchReputation, 30000);
    return () => clearInterval(interval);
  }, [authenticated, user]);

  const hasNft = false;

  if (!authenticated) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-4xl py-12 text-center">
          <Award className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
          <h1 className="mb-2 font-bold text-2xl">Reputation Dashboard</h1>
          <p className="mb-6 text-muted-foreground">
            Connect your wallet to view your on-chain reputation
          </p>
        </div>
      </PageContainer>
    );
  }

  if (!loading && !hasNft) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-4xl py-12 text-center">
          <Award className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
          <h1 className="mb-2 font-bold text-2xl">Missing Reputation NFT</h1>
          <p className="mb-6 text-muted-foreground">
            Complete on-chain onboarding to activate your public scores
          </p>
        </div>
      </PageContainer>
    );
  }

  if (loading) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-4xl py-12 text-center">
          <p className="text-muted-foreground">Loading reputation...</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="py-6 text-center">
          <h1 className="mb-2 font-bold text-3xl">Reputation Dashboard</h1>
          <p className="text-muted-foreground">
            Reputation = PnL (40%) + feedback (40%) + activity (20%)
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-2 flex items-center gap-3">
              <Award className="h-5 w-5 text-primary" />
              <span className="text-muted-foreground text-sm uppercase tracking-wide">
                Reputation
              </span>
            </div>
            <p className="font-bold text-3xl text-foreground">
              {stats.currentReputation}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              Trust: {stats.trustLevel}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-2 flex items-center gap-3">
              <Trophy className="h-5 w-5 text-green-600" />
              <span className="text-muted-foreground text-sm uppercase tracking-wide">
                Wins
              </span>
            </div>
            <p className="font-bold text-3xl text-green-600">
              {stats.totalWins}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              Avg game score: {stats.averageGameScore.toFixed(1)}
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-2 flex items-center gap-3">
              <Target className="h-5 w-5 text-red-600" />
              <span className="text-muted-foreground text-sm uppercase tracking-wide">
                Losses
              </span>
            </div>
            <p className="font-bold text-3xl text-red-600">
              {stats.totalLosses}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              Avg feedback: {stats.averageFeedbackScore.toFixed(1)} (
              {stats.totalFeedbackReceived} ratings)
            </p>
          </div>

          <div className="rounded-lg border border-border bg-card p-6">
            <div className="mb-2 flex items-center gap-3">
              <Medal className="h-5 w-5 text-primary" />
              <span className="text-muted-foreground text-sm uppercase tracking-wide">
                Win Rate
              </span>
            </div>
            <p className="font-bold text-3xl text-foreground">
              {stats.winRate.toFixed(1)}%
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {stats.totalWins}W / {stats.totalLosses}L
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 font-semibold text-lg">Your Reputation NFT</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-muted-foreground text-sm">
                Token ID
              </label>
              <p className="font-mono text-foreground">#N/A</p>
            </div>
            <div>
              <label className="mb-1 block text-muted-foreground text-sm">
                Contract Address
              </label>
              <p className="truncate font-mono text-foreground text-sm">
                {IDENTITY_REGISTRY_BASE_SEPOLIA}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 font-semibold text-lg">Recent Activity</h2>
          <p className="py-8 text-center text-muted-foreground">
            Detailed recaps are coming soon. Keep playing to power your metrics.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 font-semibold text-lg">
            How Reputation Is Calculated
          </h2>
          <div className="space-y-3 text-muted-foreground text-sm">
            <p>
              📈 <strong className="text-foreground">Performance (40%):</strong>{' '}
              normalized PnL & win rate.
            </p>
            <p>
              🗳️ <strong className="text-foreground">Feedback (40%):</strong>{' '}
              game / user / agent ratings.
            </p>
            <p>
              ♻️ <strong className="text-foreground">Activity (20%):</strong>{' '}
              linear bonus on games played (capped at 50).
            </p>
            <p>
              ⛓️ <strong className="text-foreground">On-chain:</strong> synced
              via ERC-8004 (trust & accuracy).
            </p>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
