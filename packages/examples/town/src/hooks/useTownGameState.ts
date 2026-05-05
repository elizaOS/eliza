import { useEffect, useSyncExternalStore } from "react";
import type { MafiaGameState } from "../simulation/mafiaGame";
import {
  getGameState,
  initializeTownStore,
  subscribe,
} from "../state/townStore";

export function useTownGameState(): MafiaGameState | null {
  useEffect(() => {
    void initializeTownStore();
  }, []);

  return useSyncExternalStore(subscribe, getGameState, getGameState);
}
