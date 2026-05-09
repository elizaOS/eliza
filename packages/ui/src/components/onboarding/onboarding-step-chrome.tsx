import { cn } from "@elizaos/ui";
import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { useId } from "react";
import {
  onboardingReadableTextFaintClassName,
  onboardingReadableTextMutedClassName,
  onboardingReadableTextStrongClassName,
  onboardingTextSupportClassName,
} from "./onboarding-form-primitives";

interface OnboardingStepHeaderProps {
  eyebrow: string;
  title?: string;
  description?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}

export const onboardingEyebrowClass = `text-center text-xs font-semibold uppercase tracking-[0.3em] ${onboardingReadableTextMutedClassName}`;

export const onboardingTitleClass = `text-center text-xl font-light leading-[1.4] ${onboardingReadableTextStrongClassName}`;

export const onboardingDescriptionClass = `mx-auto max-w-[36ch] text-center text-sm leading-relaxed ${onboardingReadableTextMutedClassName} ${onboardingTextSupportClassName}`;
export const onboardingHeaderBlockClass = "mb-5 max-md:mb-4";

export const onboardingFooterClass =
  "mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4";

export const onboardingSecondaryActionClass = `inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md border border-transparent bg-transparent px-3 py-2 text-xs-tight uppercase tracking-[0.14em] transition-[color,background-color,box-shadow] duration-300 hover:bg-[var(--onboarding-secondary-hover-bg)] hover:text-[var(--onboarding-text-strong)] active:bg-[var(--onboarding-secondary-pressed-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onboarding-secondary-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 ${onboardingReadableTextMutedClassName}`;

export const onboardingPrimaryActionClass =
  "group relative inline-flex min-h-touch items-center justify-center gap-2 overflow-hidden rounded-md border border-[var(--onboarding-accent-border)] bg-[var(--onboarding-accent-bg)] px-8 py-3 text-xs-tight font-semibold uppercase tracking-[0.18em] text-[var(--onboarding-accent-foreground)] transition-all duration-300 hover:border-[var(--onboarding-accent-border-hover)] hover:bg-[var(--onboarding-accent-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40";

export const onboardingLinkActionClass = `inline-flex min-h-touch min-w-touch items-center justify-center rounded-md border border-transparent bg-transparent px-3 py-2 text-xs-tight transition-[color,background-color,box-shadow] duration-300 hover:bg-[var(--onboarding-secondary-hover-bg)] hover:text-[var(--onboarding-link)] active:bg-[var(--onboarding-secondary-pressed-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onboarding-secondary-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 ${onboardingReadableTextFaintClassName}`;

export const onboardingTextShadowStyle = {
  textShadow: "var(--onboarding-text-shadow-strong)",
  WebkitTextStroke: "0.35px var(--onboarding-text-stroke)",
} as const;

export const onboardingBodyTextShadowStyle = {
  textShadow: "var(--onboarding-text-shadow-muted)",
} as const;

export const onboardingPrimaryActionTextShadowStyle = {
  textShadow: "0 1px 5px rgba(3,5,10,0.38)",
} as const;

export const onboardingSecondaryActionTextShadowStyle = {
  textShadow: "var(--onboarding-text-shadow-muted)",
} as const;

function mergeOnboardingTextShadowStyle(
  style?: CSSProperties,
): CSSProperties | undefined {
  if (!style) {
    return onboardingSecondaryActionTextShadowStyle;
  }
  return {
    ...onboardingSecondaryActionTextShadowStyle,
    ...style,
  };
}

type OnboardingActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function OnboardingSecondaryActionButton({
  className,
  style,
  type = "button",
  ...props
}: OnboardingActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(onboardingSecondaryActionClass, className)}
      style={mergeOnboardingTextShadowStyle(style)}
      {...props}
    />
  );
}

export function OnboardingLinkActionButton({
  className,
  style,
  type = "button",
  ...props
}: OnboardingActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(onboardingLinkActionClass, className)}
      style={mergeOnboardingTextShadowStyle(style)}
      {...props}
    />
  );
}

export function OnboardingStepDivider() {
  return (
    <div className="my-4 flex items-center gap-3 before:h-px before:flex-1 before:bg-gradient-to-r before:from-transparent before:via-[var(--onboarding-divider)] before:to-transparent after:h-px after:flex-1 after:bg-gradient-to-r after:from-transparent after:via-[var(--onboarding-divider)] after:to-transparent">
      <div className="h-1.5 w-1.5 shrink-0 rotate-45 bg-[rgba(240,185,11,0.4)]" />
    </div>
  );
}

export function OnboardingStepHeader({
  eyebrow,
  title,
  description,
  titleClassName = "",
  descriptionClassName = "",
}: OnboardingStepHeaderProps) {
  const reactId = useId().replace(/:/g, "");
  const headingId = `onboarding-step-heading-${reactId}`;
  const descriptionId = `onboarding-step-description-${reactId}`;
  const headingText = title || description || eyebrow;
  const usesTitleHeading = Boolean(title);
  const usesDescriptionHeading = !title && Boolean(description);
  const hasBodyDescription = Boolean(title && description);
  const headingClassName =
    usesTitleHeading || usesDescriptionHeading
      ? `${onboardingTitleClass} ${
          usesDescriptionHeading ? descriptionClassName : titleClassName
        }`.trim()
      : onboardingEyebrowClass;

  return (
    <div className={onboardingHeaderBlockClass}>
      {usesTitleHeading || usesDescriptionHeading ? (
        <p
          className={onboardingEyebrowClass}
          style={onboardingBodyTextShadowStyle}
        >
          {eyebrow}
        </p>
      ) : null}
      <OnboardingStepDivider />
      <h1
        id={headingId}
        className={headingClassName}
        style={
          usesTitleHeading || usesDescriptionHeading
            ? onboardingTextShadowStyle
            : onboardingBodyTextShadowStyle
        }
      >
        {headingText}
      </h1>
      {hasBodyDescription ? (
        <p
          id={descriptionId}
          className={`${onboardingDescriptionClass} ${descriptionClassName}`.trim()}
          style={onboardingBodyTextShadowStyle}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function spawnOnboardingRipple(
  target: HTMLElement | null,
  point?: { x: number; y: number },
) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const diameter = Math.max(rect.width, rect.height);
  const circle = document.createElement("span");
  const x = point?.x ?? rect.left + rect.width / 2;
  const y = point?.y ?? rect.top + rect.height / 2;

  circle.style.width = circle.style.height = `${diameter}px`;
  circle.style.left = `${x - rect.left - diameter / 2}px`;
  circle.style.top = `${y - rect.top - diameter / 2}px`;
  circle.className =
    "pointer-events-none absolute rounded-full bg-[var(--onboarding-ripple)] scale-0 animate-[onboarding-ripple-expand_0.6s_ease-out_forwards]";
  target.appendChild(circle);
  window.setTimeout(() => circle.remove(), 600);
}
