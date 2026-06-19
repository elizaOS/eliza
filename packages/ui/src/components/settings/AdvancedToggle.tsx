/**
 * AdvancedToggle — switch that gates "advanced" settings sections.
 *
 * Persists to `localStorage` (default OFF) and is shared across every section
 * that reads it; subscribe via `useAdvancedSettingsEnabled()`.
 */

import { useCallback, useEffect, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { Switch } from "../ui/switch";
import {
  advancedToggleListeners,
  publishAdvancedFlag,
  readPersistedAdvancedFlag,
  writePersistedAdvancedFlag,
} from "./AdvancedToggle.hooks";

export interface AdvancedToggleProps {
  /** Optional label override. Defaults to "Advanced settings". */
  label?: string;
  /** Change callback fired after the persisted state has been updated. */
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

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "backup-advanced-gate",
    role: "toggle",
    label,
    group: "settings",
    status: enabled ? "on" : "off",
    onActivate: () => handleChange(!enabled),
  });

  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: Switch (RadixUI) is a button control with role=switch; the wrapping label propagates clicks and the aria-label binds it
    <label
      className={
        className ??
        "inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-sm border border-border/50 bg-bg-hover px-3 py-1.5 text-xs font-medium text-muted-strong"
      }
    >
      <span>{label}</span>
      <Switch
        ref={ref}
        checked={enabled}
        onCheckedChange={handleChange}
        aria-label={label}
        {...agentProps}
      />
    </label>
  );
}
