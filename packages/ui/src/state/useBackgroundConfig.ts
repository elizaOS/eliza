/**
 * Hook to read + write the unified app background, backed by
 * useDisplayPreferences so every caller shares one persisted source of truth.
 */
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
  redoBackgroundConfig: () => void;
  canUndoBackground: boolean;
  canRedoBackground: boolean;
} {
  const backgroundConfig = useAppSelectorShallow((s) => s.backgroundConfig);
  const setBackgroundConfig = useAppSelector((s) => s.setBackgroundConfig);
  const undoBackgroundConfig = useAppSelector((s) => s.undoBackgroundConfig);
  const redoBackgroundConfig = useAppSelector((s) => s.redoBackgroundConfig);
  const canUndoBackground = useAppSelector((s) => s.canUndoBackground);
  const canRedoBackground = useAppSelector((s) => s.canRedoBackground);
  return {
    backgroundConfig,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
    canUndoBackground,
    canRedoBackground,
  };
}
