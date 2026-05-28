import {
  setupReadableTextMutedClassName,
  setupReadableTextStrongClassName,
  setupTextSupportClassName,
} from "./setup-form-primitives";

export const setupEyebrowClass = `text-center text-xs font-semibold uppercase tracking-[0.3em] ${setupReadableTextMutedClassName}`;

export const setupTitleClass = `text-center text-xl font-light leading-[1.4] ${setupReadableTextStrongClassName}`;

export const setupDescriptionClass = `mx-auto max-w-[36ch] text-center text-sm leading-relaxed ${setupReadableTextMutedClassName} ${setupTextSupportClassName}`;
export const setupHeaderBlockClass = "mb-5 max-md:mb-4";

export const setupFooterClass =
  "mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4";

export const setupSecondaryActionClass = `inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-sm bg-transparent px-3 py-2 text-xs-tight uppercase tracking-[0.14em] transition-[color,background-color] duration-300 hover:bg-[var(--first-run-secondary-hover-bg)] hover:text-[var(--first-run-text-strong)] active:bg-[var(--first-run-secondary-pressed-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--first-run-secondary-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 ${setupReadableTextMutedClassName}`;

export const setupPrimaryActionClass =
  "group relative inline-flex min-h-touch items-center justify-center gap-2 overflow-hidden rounded-sm bg-[var(--first-run-accent-bg)] px-8 py-3 text-xs-tight font-semibold uppercase tracking-[0.18em] text-[var(--first-run-accent-foreground)] transition-colors duration-300 hover:bg-[var(--first-run-accent-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40";

export const setupTextShadowStyle = {
  textShadow: "var(--first-run-text-shadow-strong)",
  WebkitTextStroke: "0.35px var(--first-run-text-stroke)",
} as const;

export const setupBodyTextShadowStyle = {
  textShadow: "var(--first-run-text-shadow-muted)",
} as const;

export const setupPrimaryActionTextShadowStyle = {
  textShadow: "0 1px 5px rgba(3,5,10,0.38)",
} as const;

export function SetupStepDivider() {
  return (
    <div className="my-4 flex items-center gap-3 before:h-px before:flex-1 before: before:from-transparent before:via-[var(--first-run-divider)] before:to-transparent after:h-px after:flex-1 after: after:from-transparent after:via-[var(--first-run-divider)] after:to-transparent">
      <div className="h-1.5 w-1.5 shrink-0 rotate-45 bg-[rgba(240,185,11,0.4)]" />
    </div>
  );
}
