'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { hasCompletedGameGuide } from '@/lib/game-guide-completion';

interface GameGuideContextValue {
  /** Always false; guide runs on `/onboarding`, not in a modal. */
  isOpen: boolean;
  openGuide: () => void;
  hasCompleted: boolean;
}

const GameGuideContext = createContext<GameGuideContextValue | null>(null);

/** Access game guide helpers. Throws if used outside GameGuideProvider. */
export function useGameGuide(): GameGuideContextValue {
  const ctx = useContext(GameGuideContext);
  if (!ctx) throw new Error('useGameGuide requires GameGuideProvider');
  return ctx;
}

/**
 * Product tour is unified with profile signup on `/onboarding`.
 * `openGuide` navigates there with replay query.
 */
export function GameGuideProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();

  const hasCompleted = useMemo(
    () => hasCompletedGameGuide(user?.id, user?.gameGuideCompletedAt),
    [user?.id, user?.gameGuideCompletedAt]
  );

  const openGuide = useCallback(() => {
    if (typeof window === 'undefined') {
      router.push('/onboarding?replayGuide=1');
      return;
    }
    const path = `${window.location.pathname}${window.location.search}`;
    if (path.startsWith('/onboarding')) {
      router.push('/onboarding?replayGuide=1');
      return;
    }
    const next = new URLSearchParams();
    next.set('replayGuide', '1');
    next.set('returnTo', path);
    router.push(`/onboarding?${next.toString()}`);
  }, [router]);

  const value = useMemo(
    () => ({ isOpen: false, openGuide, hasCompleted }),
    [openGuide, hasCompleted]
  );

  return (
    <GameGuideContext.Provider value={value}>
      {children}
    </GameGuideContext.Provider>
  );
}
