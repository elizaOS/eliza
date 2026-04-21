import {
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  FieldMessage,
} from "@elizaos/ui";
import * as React from "react";

export const onboardingDetailStackClassName =
  "flex w-full flex-col gap-4 text-left";
export const onboardingCenteredStackClassName =
  "flex w-full flex-col items-center gap-3 text-center";
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
export const onboardingSubtleTextClassName = `text-xs-tight leading-relaxed ${onboardingReadableTextSubtleClassName}`;
export const onboardingFieldLabelClassName = `text-xs font-semibold uppercase tracking-[0.14em] ${onboardingReadableTextMutedClassName}`;
export const onboardingInlineSupportClassName =
  "rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.05)] px-1 py-0.5 backdrop-blur-[10px]";
export const onboardingTextSupportClassName =
  "rounded-xl bg-[var(--onboarding-text-support-bg)] px-3 py-2 my-2 shadow-[var(--onboarding-text-support-shadow)] backdrop-blur-[14px]";
export const onboardingCardSurfaceClassName =
  "border border-[var(--onboarding-card-border)] bg-[var(--onboarding-card-bg)] shadow-[var(--onboarding-card-shadow)]";
export const onboardingCardSurfaceHoverClassName =
  "hover:border-[var(--onboarding-card-border-strong)] hover:bg-[var(--onboarding-card-bg-hover)]";
export const onboardingRecommendedSurfaceClassName =
  "border border-[var(--onboarding-recommended-border)] bg-[var(--onboarding-recommended-bg)] shadow-[var(--onboarding-card-shadow)]";
export const onboardingRecommendedSurfaceHoverClassName =
  "hover:border-[var(--onboarding-recommended-border-strong)] hover:bg-[var(--onboarding-recommended-bg-hover)]";
export const onboardingInputSurfaceClassName =
  "border border-[var(--onboarding-input-border)] bg-[var(--onboarding-input-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
export const onboardingInfoPanelClassName = `rounded-2xl px-4 py-4 backdrop-blur-[18px] backdrop-saturate-[1.15] ${onboardingCardSurfaceClassName}`;
export const onboardingInputClassName = `h-12 w-full rounded-xl px-4 text-left ${onboardingReadableTextPrimaryClassName} transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[var(--onboarding-text-subtle)] focus-visible:border-[var(--onboarding-field-focus-border)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[var(--onboarding-field-focus-shadow)] ${onboardingInputSurfaceClassName}`;
export const onboardingChoiceCardTitleClassName = `text-xs font-medium leading-[1.3] ${onboardingReadableTextPrimaryClassName}`;
export const onboardingChoiceCardDescriptionClassName = `mt-1 text-xs-tight leading-[1.35] ${onboardingReadableTextMutedClassName}`;
export const onboardingChoiceCardBadgeClassName =
  "ml-auto shrink-0 whitespace-nowrap rounded-full bg-[var(--onboarding-accent-bg)] px-2 py-0.5 text-3xs font-semibold uppercase tracking-[0.08em] text-[var(--onboarding-accent-foreground)] [text-shadow:0_1px_6px_rgba(3,5,10,0.45)]";
export const onboardingChoiceCardDetectedBadgeClassName =
  "ml-auto shrink-0 whitespace-nowrap rounded-full bg-[rgba(34,197,94,0.2)] px-2 py-0.5 text-3xs font-semibold uppercase tracking-[0.08em] text-[rgba(34,197,94,0.94)] [text-shadow:0_1px_6px_rgba(3,5,10,0.45)]";
export const onboardingChoiceCardRecommendedLabelClassName =
  "ml-auto shrink-0 whitespace-nowrap text-3xs font-medium uppercase tracking-[0.12em] text-accent";

export function getOnboardingChoiceCardClassName({
  detected = false,
  selected = false,
  recommended = false,
}: {
  detected?: boolean;
  selected?: boolean;
  recommended?: boolean;
}) {
  return cn(
    "flex min-h-[60px] w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left backdrop-blur-[18px] backdrop-saturate-[1.2] transition-[border-color,background-color,box-shadow] duration-200",
    recommended
      ? `${onboardingRecommendedSurfaceClassName} ${onboardingRecommendedSurfaceHoverClassName}`
      : `${onboardingCardSurfaceClassName} ${onboardingCardSurfaceHoverClassName}`,
    selected &&
      "border-[rgba(240,185,11,0.32)] bg-[rgba(240,185,11,0.12)] shadow-[0_0_0_1px_rgba(240,185,11,0.18)]",
    detected &&
      "border-[rgba(34,197,94,0.4)] bg-[rgba(34,197,94,0.1)] hover:border-[rgba(34,197,94,0.5)] hover:bg-[rgba(34,197,94,0.15)]",
  );
}

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

export const OnboardingStatusBanner = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    action?: React.ReactNode;
    live?: "polite" | "assertive";
    tone: "success" | "neutral" | "error";
  }
>(({ action, children, className, live = "polite", tone, ...props }, ref) => {
  const compactSuccess = tone === "success" && !action;
  const toneClass =
    tone === "success"
      ? "border-[var(--ok-muted)] bg-[var(--ok-subtle)] text-ok"
      : tone === "error"
        ? "border-[color:color-mix(in_srgb,var(--danger)_38%,transparent)] bg-[color:color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger"
        : `${onboardingCardSurfaceClassName} ${onboardingReadableTextMutedClassName}`;

  return (
    <div
      ref={ref}
      data-onboarding-status-layout={compactSuccess ? "compact" : "split"}
      aria-live={live}
      role={tone === "error" ? "alert" : "status"}
      tabIndex={-1}
      className={cn(
        "rounded-xl border text-sm",
        compactSuccess
          ? "mx-auto flex w-full max-w-[24rem] items-center justify-center px-5 py-4 text-center"
          : "flex w-full items-center justify-between gap-3 px-4 py-3",
        toneClass,
        className,
      )}
      {...props}
    >
      <div
        data-onboarding-status-content
        className={cn(
          compactSuccess
            ? "inline-flex items-center justify-center gap-2 text-center"
            : "flex min-w-0 flex-1 items-center gap-2 text-left",
        )}
      >
        {children}
      </div>
      {action ? (
        <div data-onboarding-status-action className="shrink-0">
          {action}
        </div>
      ) : null}
    </div>
  );
});
OnboardingStatusBanner.displayName = "OnboardingStatusBanner";
