/**
 * AdvancedToggle — small switch that gates "advanced" settings sections.
 *
 * Persists its on/off state to `localStorage` under the
 * `ADVANCED_TOGGLE_STORAGE_KEY` key so the choice survives reloads and is
 * shared across every settings section that reads it. The default is OFF
 * (non-advanced) — most users never see ASR provider pickers or other
 * power-user knobs.
 *
 * Other components can subscribe to the persisted state via
 * `useAdvancedSettingsEnabled()`.
 */

import { useCallback, useEffect, useState } from "react";
import { Switch } from "../ui/switch";
import {
  advancedToggleListeners,
  publishAdvancedFlag,
  readPersistedAdvancedFlag,
  writePersistedAdvancedFlag,
} from "./AdvancedToggle.hooks";

export interface AdvancedToggleProps {
  /**
   * Optional label override. Defaults to "Advanced settings". The string is
   * intentionally English-only — this codebase does not localize the
   * settings panel yet.
   */
  label?: string;
  /**
   * Optional change callback fired after the persisted state has been
   * updated. Mostly useful for tests / analytics.
   */
  onChange?: (enabled: boolean) => void;
  className?: string;
}

export function AdvancedToggle(props: AdvancedToggleProps) {
  const { label = "Advanced settings", onChange, className } = props;
  const [enabled, setEnabled] = useState<boolean>(readPersistedAdvancedFlag);

  // Stay in sync with any other AdvancedToggle on the page.
  useEffect(() => {
    setEnabled(readPersistedAdvancedFlag());
    advancedToggleListeners.add(setEnabled);
    return () => {
      advancedToggleListeners.delete(setEnabled);
    };
  }, []);

  const handleChange = useCallback(
    (next: boolean) => {
      setEnabled(next);
      writePersistedAdvancedFlag(next);
      publishAdvancedFlag(next);
      onChange?.(next);
    },
    [onChange],
  );

  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Switch (RadixUI) is a button control with role=switch; the wrapping label propagates clicks and the aria-label binds it
    <label
      className={
        className ??
        "inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-sm border border-border/50 bg-bg-hover px-3 py-1.5 text-xs-tight font-medium text-muted-strong"
      }
    >
      <span>{label}</span>
      <Switch
        checked={enabled}
        onCheckedChange={handleChange}
        aria-label={label}
      />
    </label>
  );
}
