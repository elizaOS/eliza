/**
 * Shares first-run presentation classes without mixing non-component exports
 * into React modules, preserving their Fast Refresh boundaries.
 */

export const setupDetailStackClassName = "flex w-full flex-col gap-4 text-left";
export const setupReadableTextStrongClassName =
  "text-[var(--first-run-text-strong)] [text-shadow:var(--first-run-text-shadow-strong)] [-webkit-text-stroke:0.3px_var(--first-run-text-stroke)]";
export const setupReadableTextPrimaryClassName =
  "text-[var(--first-run-text-primary)] [text-shadow:var(--first-run-text-shadow-primary)]";
export const setupReadableTextMutedClassName =
  "text-[var(--first-run-text-muted)] [text-shadow:var(--first-run-text-shadow-muted)]";

export const setupHelperTextClassName = `text-xs leading-relaxed ${setupReadableTextMutedClassName}`;
export const setupFieldLabelClassName = `text-xs font-semibold uppercase tracking-[0.14em] ${setupReadableTextMutedClassName}`;

export const setupEyebrowClass = `text-center text-xs font-semibold uppercase tracking-[0.3em] ${setupReadableTextMutedClassName}`;
export const setupTitleClass = `text-center text-xl font-light leading-[1.4] ${setupReadableTextStrongClassName}`;
export const setupDescriptionClass = `mx-auto my-2 max-w-[36ch] text-center text-sm leading-relaxed ${setupReadableTextMutedClassName}`;
export const setupHeaderBlockClass = "mb-5 max-md:mb-4";
export const setupFooterClass =
  "mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4";

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
