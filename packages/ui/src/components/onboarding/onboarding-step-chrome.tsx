import {
  onboardingReadableTextMutedClassName,
  onboardingReadableTextStrongClassName,
  onboardingTextSupportClassName,
} from "./onboarding-form-primitives";

export const onboardingEyebrowClass = `text-center text-xs font-semibold uppercase tracking-[0.3em] ${onboardingReadableTextMutedClassName}`;

export const onboardingTitleClass = `text-center text-xl font-light leading-[1.4] ${onboardingReadableTextStrongClassName}`;

export const onboardingDescriptionClass = `mx-auto max-w-[36ch] text-center text-sm leading-relaxed ${onboardingReadableTextMutedClassName} ${onboardingTextSupportClassName}`;
export const onboardingHeaderBlockClass = "mb-5 max-md:mb-4";

export const onboardingFooterClass =
  "mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4";

export const onboardingSecondaryActionClass = `inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-md border border-transparent bg-transparent px-3 py-2 text-xs-tight uppercase tracking-[0.14em] transition-[color,background-color,box-shadow] duration-300 hover:bg-[var(--onboarding-secondary-hover-bg)] hover:text-[var(--onboarding-text-strong)] active:bg-[var(--onboarding-secondary-pressed-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--onboarding-secondary-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 ${onboardingReadableTextMutedClassName}`;

export const onboardingPrimaryActionClass =
  "group relative inline-flex min-h-touch items-center justify-center gap-2 overflow-hidden rounded-md border border-[var(--onboarding-accent-border)] bg-[var(--onboarding-accent-bg)] px-8 py-3 text-xs-tight font-semibold uppercase tracking-[0.18em] text-[var(--onboarding-accent-foreground)] transition-all duration-300 hover:border-[var(--onboarding-accent-border-hover)] hover:bg-[var(--onboarding-accent-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40";

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

export function OnboardingStepDivider() {
  return (
    <div className="my-4 flex items-center gap-3 before:h-px before:flex-1 before:bg-gradient-to-r before:from-transparent before:via-[var(--onboarding-divider)] before:to-transparent after:h-px after:flex-1 after:bg-gradient-to-r after:from-transparent after:via-[var(--onboarding-divider)] after:to-transparent">
      <div className="h-1.5 w-1.5 shrink-0 rotate-45 bg-[rgba(240,185,11,0.4)]" />
    </div>
  );
}
