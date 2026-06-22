import { useAppSelector, useAppSelectorShallow } from "./app-store";
import type { BackgroundConfig } from "./ui-preferences";

/**
 * Read + write the unified app background. The config is owned by
 * `useDisplayPreferences` (persisted to localStorage) and surfaced through the
 * app store, so every caller — the root background layer and the Background
 * view — shares one source of truth and stays in sync across views.
 */
export function useBackgroundConfig(): {
  backgroundConfig: BackgroundConfig;
  setBackgroundConfig: (config: BackgroundConfig) => void;
} {
  const backgroundConfig = useAppSelectorShallow((s) => s.backgroundConfig);
  const setBackgroundConfig = useAppSelector((s) => s.setBackgroundConfig);
  return { backgroundConfig, setBackgroundConfig };
}
