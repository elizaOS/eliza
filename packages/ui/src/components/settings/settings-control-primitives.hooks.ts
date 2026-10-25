/**
 * `useSettingsSave` — shared save-button state machine for settings panels:
 * runs the caller's async `onSave`, tracks saving/error/success, and clears the
 * transient success flag after a timeout.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseSettingsSaveOptions {
  onSave: () => Promise<void> | void;
  successMs?: number;
  errorFallback?: string;
}

export interface UseSettingsSaveResult {
  saving: boolean;
  saveError: string | null;
  saveSuccess: boolean;
  handleSave: () => Promise<void>;
  resetStatus: () => void;
}

export function useSettingsSave(
  options: UseSettingsSaveOptions,
): UseSettingsSaveResult {
  const {
    onSave,
    successMs = 2500,
    errorFallback = "Failed to save.",
  } = options;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const clearSuccessTimer = useCallback(() => {
    if (successTimerRef.current !== null) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  const resetStatus = useCallback(() => {
    clearSuccessTimer();
    setSaveError(null);
    setSaveSuccess(false);
  }, [clearSuccessTimer]);

  const handleSave = useCallback(async () => {
    clearSuccessTimer();
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await onSaveRef.current();
      setSaveSuccess(true);
      successTimerRef.current = setTimeout(() => {
        setSaveSuccess(false);
        successTimerRef.current = null;
      }, successMs);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : errorFallback);
    } finally {
      setSaving(false);
    }
  }, [clearSuccessTimer, errorFallback, successMs]);

  useEffect(() => clearSuccessTimer, [clearSuccessTimer]);

  return { saving, saveError, saveSuccess, handleSave, resetStatus };
}
