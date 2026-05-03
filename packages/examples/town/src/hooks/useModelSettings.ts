import { useEffect, useSyncExternalStore } from "react";
import type { ModelSettings } from "../runtime/modelSettings";
import {
  getModelSettings,
  initializeTownStore,
  setModelSettings,
  subscribe,
} from "../state/townStore";

export function useModelSettings(): ModelSettings {
  useEffect(() => {
    void initializeTownStore();
  }, []);

  return useSyncExternalStore(subscribe, getModelSettings, getModelSettings);
}

export function useUpdateModelSettings(): (settings: ModelSettings) => void {
  return setModelSettings;
}
