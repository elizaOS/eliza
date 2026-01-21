import { useEffect, useSyncExternalStore } from "react";
import type { TownState } from "../../shared/types";
import {
  getTownState,
  initializeTownStore,
  subscribe,
} from "../state/townStore";

export function useTownState(): TownState | null {
  useEffect(() => {
    void initializeTownStore();
  }, []);

  return useSyncExternalStore(subscribe, getTownState, getTownState);
}
