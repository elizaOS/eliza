import type * as React from "react";
import { cn } from "../../lib/utils";
import { Field, FieldDescription, FieldLabel, FieldMessage } from "../ui/field";

export const setupDetailStackClassName = "flex w-full flex-col gap-4 text-left";
export const setupReadableTextStrongClassName =
  "text-[var(--first-run-text-strong)] [text-shadow:var(--first-run-text-shadow-strong)] [-webkit-text-stroke:0.3px_var(--first-run-text-stroke)]";
export const setupReadableTextPrimaryClassName =
  "text-[var(--first-run-text-primary)] [text-shadow:var(--first-run-text-shadow-primary)]";
export const setupReadableTextMutedClassName =
  "text-[var(--first-run-text-muted)] [text-shadow:var(--first-run-text-shadow-muted)]";
export const setupReadableTextSubtleClassName =
  "text-[var(--first-run-text-subtle)] [text-shadow:var(--first-run-text-shadow-muted)]";
export const setupReadableTextFaintClassName =
  "text-[var(--first-run-text-faint)] [text-shadow:var(--first-run-text-shadow-muted)]";
export const setupHelperTextClassName = `text-xs leading-relaxed ${setupReadableTextMutedClassName}`;
const setupFieldLabelClassName = `text-xs font-semibold uppercase tracking-[0.14em] ${setupReadableTextMutedClassName}`;
export const setupTextSupportClassName =
  "rounded-sm bg-[var(--first-run-text-support-bg)] px-3 py-2 my-2";
const setupInputSurfaceClassName = "bg-[var(--first-run-input-bg)]";
export const setupInputClassName = `h-12 w-full rounded-sm px-4 text-left ${setupReadableTextPrimaryClassName} transition-[border-color,background-color] duration-200 placeholder:text-[var(--first-run-text-subtle)] focus-visible:border-[var(--first-run-field-focus-border)] focus-visible:ring-0 focus-visible:ring-offset-0 ${setupInputSurfaceClassName}`;

interface SetupFieldProps {
  align?: "left" | "center";
  children: (controlProps: {
    describedBy?: string;
    invalid: boolean;
  }) => React.ReactNode;
  className?: string;
  controlId?: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  label?: React.ReactNode;
  labelClassName?: string;
  message?: React.ReactNode;
  messageClassName?: string;
  messageTone?: "default" | "danger" | "success";
}

export function SetupField({
  align = "left",
  children,
  className,
  controlId,
  description,
  descriptionClassName,
  label,
  labelClassName,
  message,
  messageClassName,
  messageTone = "default",
}: SetupFieldProps) {
  const descriptionId =
    controlId && description ? `${controlId}-description` : undefined;
  const messageId = controlId && message ? `${controlId}-message` : undefined;
  const describedBy =
    [descriptionId, messageId].filter(Boolean).join(" ") || undefined;
  const isInvalid = Boolean(message) && messageTone === "danger";

  return (
    <Field
      className={cn(
        "w-full gap-2.5",
        align === "center" ? "items-center text-center" : "text-left",
        className,
      )}
    >
      {label ? (
        <FieldLabel
          htmlFor={controlId}
          className={cn(
            setupFieldLabelClassName,
            align === "center" && "text-center",
            labelClassName,
          )}
        >
          {label}
        </FieldLabel>
      ) : null}
      {children({ describedBy, invalid: isInvalid })}
      {description ? (
        <FieldDescription
          id={descriptionId}
          className={cn(
            setupHelperTextClassName,
            align === "center" && "text-center",
            descriptionClassName,
          )}
        >
          {description}
        </FieldDescription>
      ) : null}
      {message ? (
        <FieldMessage
          id={messageId}
          tone={messageTone}
          aria-live={messageTone === "danger" ? "assertive" : "polite"}
          className={cn(
            "leading-relaxed",
            align === "center" && "text-center",
            messageClassName,
          )}
        >
          {message}
        </FieldMessage>
      ) : null}
    </Field>
  );
}
