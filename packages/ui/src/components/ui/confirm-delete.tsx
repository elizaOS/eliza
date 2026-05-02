import * as React from "react";
import { cn } from "../../lib/utils";

export interface ConfirmDeleteProps {
  onConfirm: () => void;
  disabled?: boolean;
  triggerLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  promptText?: string;
  className?: string;
  /** Override the trigger button class (replaces default). */
  triggerClassName?: string;
  /** Override the confirm button class (replaces default). */
  confirmClassName?: string;
  /** Override the cancel button class (replaces default). */
  cancelClassName?: string;
  /** Override the prompt text class (replaces default). */
  promptClassName?: string;
}

export function ConfirmDelete({
  onConfirm,
  disabled = false,
  triggerLabel = "Delete",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busyLabel,
  promptText = "Delete?",
  className,
  triggerClassName,
  confirmClassName,
  cancelClassName,
  promptClassName,
}: ConfirmDeleteProps) {
  const [confirming, setConfirming] = React.useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className={
          triggerClassName ??
          cn(
            "rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-destructive hover:text-destructive",
            className,
          )
        }
        onClick={() => setConfirming(true)}
        disabled={disabled}
      >
        {triggerLabel}
      </button>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={promptClassName ?? "text-xs-tight text-destructive"}>
        {promptText}
      </span>
      <button
        type="button"
        className={
          confirmClassName ??
          "rounded-md border border-destructive bg-destructive px-2 py-0.5 text-2xs font-medium text-destructive-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        }
        onClick={() => {
          onConfirm();
          setConfirming(false);
        }}
        disabled={disabled}
      >
        {disabled && busyLabel ? busyLabel : confirmLabel}
      </button>
      <button
        type="button"
        className={
          cancelClassName ??
          "rounded-md border border-border px-2 py-0.5 text-2xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        }
        onClick={() => setConfirming(false)}
        disabled={disabled}
      >
        {cancelLabel}
      </button>
    </span>
  );
}
