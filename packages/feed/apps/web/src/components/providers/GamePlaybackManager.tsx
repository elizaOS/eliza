'use client';

import { useEffect, useRef } from 'react';
import { useGameStore } from '@/stores/gameStore';

/**
 * Game playback manager component for managing game timeline advancement.
 *
 * Runs in the background across all pages to keep the game timeline advancing
 * when playback is active. Uses interval-based time advancement based on
 * playback speed. Does not render any UI.
 *
 * Features:
 * - Background timeline advancement
 * - Speed-based intervals
 * - Play/pause support
 * - Automatic cleanup
 *
 * @returns null (does not render anything)
 */
export function GamePlaybackManager() {
  const { isPlaying, speed, totalDurationMs, advanceTime } = useGameStore();
  const intervalRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    if (isPlaying && totalDurationMs > 0) {
      intervalRef.current = setInterval(() => {
        advanceTime(speed);
      }, 50);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, speed, totalDurationMs, advanceTime]);

  // This component doesn't render anything
  return null;
}
