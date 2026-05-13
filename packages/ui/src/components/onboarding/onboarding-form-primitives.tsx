import type * as React from "react";
import { cn } from "../../lib/utils";
import { Field, FieldDescription, FieldLabel, FieldMessage } from "../ui/field";

export const onboardingDetailStackClassName =
  "flex w-full flex-col gap-4 text-left";
export const onboardingReadableTextStrongClassName =
  "text-[var(--onboarding-text-strong)] [text-shadow:var(--onboarding-text-shadow-strong)] [-webkit-text-stroke:0.3px_var(--onboarding-text-stroke)]";
export const onboardingReadableTextPrimaryClassName =
  "text-[var(--onboarding-text-primary)] [text-shadow:var(--onboarding-text-shadow-primary)]";
export const onboardingReadableTextMutedClassName =
  "text-[var(--onboarding-text-muted)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export const onboardingReadableTextSubtleClassName =
  "text-[var(--onboarding-text-subtle)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export const onboardingReadableTextFaintClassName =
  "text-[var(--onboarding-text-faint)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export const onboardingHelperTextClassName = `text-xs leading-relaxed ${onboardingReadableTextMutedClassName}`;
const onboardingFieldLabelClassName = `text-xs font-semibold uppercase tracking-[0.14em] ${onboardingReadableTextMutedClassName}`;
export const onboardingTextSupportClassName =
  "rounded-xl bg-[var(--onboarding-text-support-bg)] px-3 py-2 my-2 shadow-[var(--onboarding-text-support-shadow)] backdrop-blur-[14px]";
const onboardingInputSurfaceClassName =
  "border border-[var(--onboarding-input-border)] bg-[var(--onboarding-input-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
export const onboardingInputClassName = `h-12 w-full rounded-xl px-4 text-left ${onboardingReadableTextPrimaryClassName} transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[var(--onboarding-text-subtle)] focus-visible:border-[var(--onboarding-field-focus-border)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[var(--onboarding-field-focus-shadow)] ${onboardingInputSurfaceClassName}`;

interface OnboardingFieldProps {
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

export function OnboardingField({
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
}: OnboardingFieldProps) {
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
            onboardingFieldLabelClassName,
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
            onboardingHelperTextClassName,
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
