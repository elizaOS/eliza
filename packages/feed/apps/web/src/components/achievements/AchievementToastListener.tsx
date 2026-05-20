'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useSSEChannel } from '@/hooks/useSSE';
import { useAuthStore } from '@/stores/authStore';

export function AchievementToastListener() {
  const { authenticated } = useAuth();
  const { user } = useAuthStore();

  const handleNotification = useCallback((data: Record<string, unknown>) => {
    const type = data.type as string;

    if (type === 'achievement_unlocked') {
      const name = data.name as string;
      const tier = data.tier as string;
      const points = data.pointsReward as number;
      toast.success(`Achievement Unlocked: ${name}`, {
        description: `${tier.charAt(0).toUpperCase() + tier.slice(1)} tier — +${points} points`,
        duration: 5000,
      });
    } else if (type === 'challenge_completed') {
      const name = data.name as string;
      const points = data.pointsReward as number;
      toast.success(`Challenge Complete: ${name}`, {
        description: `+${points} points`,
        duration: 4000,
      });
    } else if (type === 'challenge_bonus') {
      const pool = data.pool as string;
      const bonus = data.bonus as number;
      toast.success(
        pool === 'daily'
          ? 'All Daily Challenges Complete!'
          : 'All Weekly Challenges Complete!',
        {
          description: `+${bonus} bonus points`,
          duration: 5000,
        }
      );
    }
  }, []);

  const channel =
    authenticated && user?.id ? (`notifications:${user.id}` as const) : null;

  useSSEChannel(channel, handleNotification);

  return null;
}
