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
export declare function ConfirmDelete({
  onConfirm,
  disabled,
  triggerLabel,
  confirmLabel,
  cancelLabel,
  busyLabel,
  promptText,
  className,
  triggerClassName,
  confirmClassName,
  cancelClassName,
  promptClassName,
}: ConfirmDeleteProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=confirm-delete.d.ts.map
