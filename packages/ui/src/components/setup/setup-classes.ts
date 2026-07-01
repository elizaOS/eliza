// Shared first-run / setup styling tokens. Pure string + style constants kept
// out of the component modules so those stay Fast-Refresh-clean: a module that
// exports a component alongside an object/array export (e.g. a style object)
// breaks the React refresh boundary and forces a full reload.

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
export const setupFieldLabelClassName = `text-xs font-semibold uppercase tracking-[0.14em] ${setupReadableTextMutedClassName}`;
export const setupTextSupportClassName =
  "rounded-sm bg-[var(--first-run-text-support-bg)] px-3 py-2 my-2";
const setupInputSurfaceClassName = "bg-[var(--first-run-input-bg)]";
export const setupInputClassName = `h-12 w-full rounded-sm px-4 text-left ${setupReadableTextPrimaryClassName} transition-[border-color,background-color] duration-200 placeholder:text-[var(--first-run-text-subtle)]    ${setupInputSurfaceClassName}`;

export const setupEyebrowClass = `text-center text-xs font-semibold uppercase tracking-[0.3em] ${setupReadableTextMutedClassName}`;
export const setupTitleClass = `text-center text-xl font-light leading-[1.4] ${setupReadableTextStrongClassName}`;
export const setupDescriptionClass = `mx-auto max-w-[36ch] text-center text-sm leading-relaxed ${setupReadableTextMutedClassName} ${setupTextSupportClassName}`;
export const setupHeaderBlockClass = "mb-5 max-md:mb-4";
export const setupFooterClass =
  "mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 pt-4";
export const setupSecondaryActionClass = `inline-flex min-h-touch min-w-touch items-center justify-center gap-2 rounded-sm bg-transparent px-3 py-2 text-xs-tight uppercase tracking-[0.14em] transition-[color,background-color] duration-300 hover:bg-[var(--first-run-secondary-hover-bg)] hover:text-[var(--first-run-text-strong)] active:bg-[var(--first-run-secondary-pressed-bg)]      disabled:pointer-events-none disabled:opacity-50 ${setupReadableTextMutedClassName}`;
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
