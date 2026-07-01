import { useAppSelector, useAppSelectorShallow } from "./app-store";
import type { BackgroundConfig } from "./ui-preferences";

/**
 * Read + write the unified app background. The config is owned by
 * `useDisplayPreferences` (persisted to localStorage) and surfaced through the
 * app store, so every caller — the root background layer, the Background view,
 * and the agent's `background:apply` bridge — shares one source of truth and
 * stays in sync across views. `undoBackgroundConfig` steps back through the
 * persisted history; `canUndoBackground` gates the undo control.
 */
export function useBackgroundConfig(): {
  backgroundConfig: BackgroundConfig;
  setBackgroundConfig: (config: BackgroundConfig) => void;
  undoBackgroundConfig: () => void;
  canUndoBackground: boolean;
} {
  const backgroundConfig = useAppSelectorShallow((s) => s.backgroundConfig);
  const setBackgroundConfig = useAppSelector((s) => s.setBackgroundConfig);
  const undoBackgroundConfig = useAppSelector((s) => s.undoBackgroundConfig);
  const canUndoBackground = useAppSelector((s) => s.canUndoBackground);
  return {
    backgroundConfig,
    setBackgroundConfig,
    undoBackgroundConfig,
    canUndoBackground,
  };
}
