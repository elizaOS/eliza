import type { GeneratedGame } from '@babylon/engine/client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TimelineDay {
  day: number;
  timestamp: number;
  label: string;
  gameId: string;
  gameName: string;
}

interface GameRange {
  gameId: string;
  gameName: string;
  startTime: number;
  endTime: number;
}

interface GameState {
  // Loaded games
  allGames: GeneratedGame[];
  loading: boolean;
  error: string | null;

  // Playback state
  currentTimeMs: number;
  isPlaying: boolean;
  speed: number;

  // Timeline data
  startTime: number | null;
  endTime: number | null;
  totalDurationMs: number;
  timelineDays: TimelineDay[];
  gameRanges: GameRange[];

  // Actions
  setAllGames: (games: GeneratedGame[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setCurrentTimeMs: (ms: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  setTimelineData: (data: {
    startTime: number | null;
    endTime: number | null;
    totalDurationMs: number;
    timelineDays: TimelineDay[];
    gameRanges: GameRange[];
  }) => void;
  advanceTime: (speedMultiplier: number) => void;
  reset: () => void;
}

export const useGameStore = create<GameState>()(
  persist(
    (set) => ({
      // Initial state
      allGames: [],
      loading: false,
      error: null,
      currentTimeMs: 0,
      isPlaying: false,
      speed: 1,
      startTime: null,
      endTime: null,
      totalDurationMs: 0,
      timelineDays: [],
      gameRanges: [],

      // Actions
      setAllGames: (games) => set({ allGames: games }),
      setLoading: (loading) => set({ loading }),
      setError: (error) => set({ error }),
      setCurrentTimeMs: (ms) => set({ currentTimeMs: ms }),
      setIsPlaying: (playing) => set({ isPlaying: playing }),
      setSpeed: (speed) => set({ speed }),
      setTimelineData: (data) => set(data),
      advanceTime: (speedMultiplier: number) =>
        set((state) => {
          const next = state.currentTimeMs + 1000 * speedMultiplier;
          if (next >= state.totalDurationMs) {
            return { currentTimeMs: state.totalDurationMs, isPlaying: false };
          }
          return { currentTimeMs: next };
        }),
      reset: () =>
        set({
          allGames: [],
          loading: false,
          error: null,
          currentTimeMs: 0,
          isPlaying: false,
          speed: 1,
          startTime: null,
          endTime: null,
          totalDurationMs: 0,
          timelineDays: [],
          gameRanges: [],
        }),
    }),
    {
      name: 'babylon-game',
      partialize: (state) => ({
        // Only persist some state
        speed: state.speed,
        currentTimeMs: state.currentTimeMs,
      }),
    }
  )
);
