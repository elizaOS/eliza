import { Button } from "../ui/button";
import { type ReactNode, useState } from "react";
import { useApp } from "../../state";

type ConfirmDeleteControlProps = {
  onConfirm: () => void;
  disabled?: boolean;
  triggerLabel?: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  promptText?: string;
  triggerClassName: string;
  confirmClassName: string;
  cancelClassName: string;
  promptClassName?: string;
  triggerTitle?: string;
  triggerVariant?: "destructive" | "outline" | "ghost";
};

export function ConfirmDeleteControl({
  onConfirm,
  disabled = false,
  triggerLabel,
  confirmLabel,
  cancelLabel,
  busyLabel,
  promptText,
  triggerClassName,
  confirmClassName,
  cancelClassName,
  promptClassName = "text-xs-tight text-[#e74c3c] ml-1",
  triggerTitle,
  triggerVariant = "destructive",
}: ConfirmDeleteControlProps) {
  const { t } = useApp();
  const [confirming, setConfirming] = useState(false);
  const resolvedTriggerLabel =
    triggerLabel ?? t("common.delete", { defaultValue: "Delete" });
  const resolvedConfirmLabel =
    confirmLabel ?? t("common.confirm", { defaultValue: "Confirm" });
  const resolvedCancelLabel =
    cancelLabel ?? t("common.cancel", { defaultValue: "Cancel" });
  const resolvedPromptText =
    promptText ?? t("conversations.deleteConfirm", { defaultValue: "Delete?" });

  if (!confirming) {
    return (
      <Button
        variant={triggerVariant}
        size="sm"
        type="button"
        className={triggerClassName}
        onClick={() => setConfirming(true)}
        disabled={disabled}
        title={triggerTitle}
        aria-label={triggerTitle}
      >
        {resolvedTriggerLabel}
      </Button>
    );
  }

  return (
    <>
      <span className={promptClassName}>{resolvedPromptText}</span>
      <Button
        variant="destructive"
        size="sm"
        type="button"
        className={confirmClassName}
        onClick={() => {
          onConfirm();
          setConfirming(false);
        }}
        disabled={disabled}
      >
        {disabled && busyLabel ? busyLabel : resolvedConfirmLabel}
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        className={cancelClassName}
        onClick={() => setConfirming(false)}
        disabled={disabled}
      >
        {resolvedCancelLabel}
      </Button>
    </>
  );
}
