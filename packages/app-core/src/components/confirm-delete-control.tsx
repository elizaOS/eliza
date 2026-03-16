import { useState } from "react";

type ConfirmDeleteControlProps = {
  onConfirm: () => void;
  disabled?: boolean;
  triggerLabel?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  promptText?: string;
  triggerClassName: string;
  confirmClassName: string;
  cancelClassName: string;
  promptClassName?: string;
};

export function ConfirmDeleteControl({
  onConfirm,
  disabled = false,
  triggerLabel = "Delete",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busyLabel,
  promptText = "Delete?",
  triggerClassName,
  confirmClassName,
  cancelClassName,
  promptClassName = "text-[11px] text-[#e74c3c] ml-1",
}: ConfirmDeleteControlProps) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className={triggerClassName}
        onClick={() => setConfirming(true)}
        disabled={disabled}
      >
        {triggerLabel}
      </button>
    );
  }

  return (
    <>
      <span className={promptClassName}>{promptText}</span>
      <button
        type="button"
        className={confirmClassName}
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
        className={cancelClassName}
        onClick={() => setConfirming(false)}
        disabled={disabled}
      >
        {cancelLabel}
      </button>
    </>
  );
}
