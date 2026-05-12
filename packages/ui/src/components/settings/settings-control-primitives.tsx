import { cn, Field, FieldDescription, FieldLabel } from "@elizaos/ui";
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export function SettingsField({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <Field className={cn("gap-1.5", className)} {...props} />;
}

export function SettingsFieldLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof FieldLabel>) {
  return (
    <FieldLabel
      className={cn("text-xs font-semibold text-txt", className)}
      {...props}
    />
  );
}

export function SettingsFieldDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof FieldDescription>) {
  return (
    <FieldDescription
      className={cn("text-xs-tight text-muted", className)}
      {...props}
    />
  );
}

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

export function AdvancedSettingsDisclosure({
  title = "Advanced",
  children,
  className,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details
      className={cn(
        "group rounded-xl border border-border/60 bg-card/45 px-3 py-2",
        className,
      )}
    >
      <summary className="cursor-pointer select-none list-none text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-txt">
        {title}
      </summary>
      <div className="mt-3 border-t border-border/40 pt-3">{children}</div>
    </details>
  );
}
