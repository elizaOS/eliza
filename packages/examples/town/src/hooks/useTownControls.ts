import { useEffect, useSyncExternalStore } from "react";
import {
  advanceGamePhase,
  getIsRunning,
  initializeTownStore,
  pauseGame,
  resetGame,
  resetTownState,
  setRunning,
  startGameRound,
  subscribe,
  toggleRunning,
} from "../state/townStore";

export function useIsRunning(): boolean {
  useEffect(() => {
    void initializeTownStore();
  }, []);
  return useSyncExternalStore(subscribe, getIsRunning, getIsRunning);
}

export function useToggleRunning(): () => void {
  return toggleRunning;
}

export function useSetRunning(): (next: boolean) => void {
  return setRunning;
}

export function useResetTown(): () => Promise<void> {
  return resetTownState;
}

export function useStartGameRound(): () => void {
  return startGameRound;
}

export function usePauseGame(): (paused: boolean) => void {
  return pauseGame;
}

export function useResetGame(): () => void {
  return resetGame;
}

export function useAdvanceGamePhase(): () => void {
  return advanceGamePhase;
}
