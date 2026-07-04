/**
 * Inline two-step delete confirmation: a trigger button that, once clicked,
 * swaps in place for a prompt + Confirm/Cancel pair (no modal). Each of the
 * three buttons registers as an agent element via `useAgentElement` so the
 * agent can drive the flow; labels fall back to the i18n `common.*` /
 * `conversations.deleteConfirm` keys. Class names for each button are supplied
 * by the caller so it inherits the host surface's styling.
 */

import { type ReactNode, useId, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";

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
  agentId?: string;
  agentLabel?: string;
  agentGroup?: string;
  agentDescription?: string;
  confirmAgentId?: string;
  cancelAgentId?: string;
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
  agentId,
  agentLabel,
  agentGroup,
  agentDescription,
  confirmAgentId,
  cancelAgentId,
}: ConfirmDeleteControlProps) {
  const t = useAppSelector((s) => s.t);
  const [confirming, setConfirming] = useState(false);
  const fallbackId = useId().replace(/[^a-z0-9_-]/gi, "");
  const resolvedTriggerLabel =
    triggerLabel ?? t("common.delete", { defaultValue: "Delete" });
  const resolvedConfirmLabel =
    confirmLabel ?? t("common.confirm", { defaultValue: "Confirm" });
  const resolvedCancelLabel =
    cancelLabel ?? t("common.cancel", { defaultValue: "Cancel" });
  const resolvedPromptText =
    promptText ?? t("conversations.deleteConfirm", { defaultValue: "Delete?" });
  const triggerAgentLabel =
    agentLabel ??
    (typeof resolvedTriggerLabel === "string"
      ? resolvedTriggerLabel
      : triggerTitle) ??
    t("common.delete", { defaultValue: "Delete" });
  const openConfirm = () => setConfirming(true);
  const confirmDelete = () => {
    onConfirm();
    setConfirming(false);
  };
  const cancelDelete = () => setConfirming(false);
  const triggerAgent = useAgentElement<HTMLButtonElement>({
    id: agentId ?? `confirm-delete-${fallbackId}-open`,
    role: "button",
    label: triggerAgentLabel,
    group: agentGroup,
    description: agentDescription,
    onActivate: openConfirm,
  });
  const confirmAgent = useAgentElement<HTMLButtonElement>({
    id: confirmAgentId ?? `confirm-delete-${fallbackId}-confirm`,
    role: "button",
    label:
      typeof resolvedConfirmLabel === "string"
        ? resolvedConfirmLabel
        : t("common.confirm", { defaultValue: "Confirm" }),
    group: agentGroup,
    onActivate: confirmDelete,
  });
  const cancelAgent = useAgentElement<HTMLButtonElement>({
    id: cancelAgentId ?? `confirm-delete-${fallbackId}-cancel`,
    role: "button",
    label:
      typeof resolvedCancelLabel === "string"
        ? resolvedCancelLabel
        : t("common.cancel", { defaultValue: "Cancel" }),
    group: agentGroup,
    onActivate: cancelDelete,
  });

  if (!confirming) {
    return (
      <Button
        ref={triggerAgent.ref}
        variant={triggerVariant}
        size="sm"
        type="button"
        className={triggerClassName}
        onClick={openConfirm}
        disabled={disabled}
        title={triggerTitle}
        aria-label={triggerTitle}
        {...triggerAgent.agentProps}
      >
        {resolvedTriggerLabel}
      </Button>
    );
  }

  return (
    <>
      <span className={promptClassName}>{resolvedPromptText}</span>
      <Button
        ref={confirmAgent.ref}
        variant="destructive"
        size="sm"
        type="button"
        className={confirmClassName}
        onClick={confirmDelete}
        disabled={disabled}
        {...confirmAgent.agentProps}
      >
        {disabled && busyLabel ? busyLabel : resolvedConfirmLabel}
      </Button>
      <Button
        ref={cancelAgent.ref}
        variant="outline"
        size="sm"
        type="button"
        className={cancelClassName}
        onClick={cancelDelete}
        disabled={disabled}
        {...cancelAgent.agentProps}
      >
        {resolvedCancelLabel}
      </Button>
    </>
  );
}
