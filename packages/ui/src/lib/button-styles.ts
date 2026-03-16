/**
 * Shared button class strings for consistent styling across views.
 *
 * These CSS class strings complement the `Button` component for cases where
 * a plain HTML `button` element is used or Tailwind class composition is
 * preferred over the variant prop.
 */

export const btnPrimary =
  "px-4 py-2 text-sm font-medium bg-[var(--accent)] text-[var(--accent-foreground,#1a1f26)] border border-[var(--accent)] cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-default rounded-lg";

export const btnGhost =
  "px-3 py-1.5 text-xs bg-transparent text-[var(--muted)] border border-[var(--border)] cursor-pointer hover:text-[var(--txt)] hover:border-[var(--txt)] transition-colors disabled:opacity-40 disabled:cursor-default rounded-lg";

export const btnDanger =
  "px-3 py-1.5 text-xs bg-transparent text-[var(--danger,#e74c3c)] border border-[var(--danger,#e74c3c)] cursor-pointer hover:bg-[var(--danger,#e74c3c)] hover:text-white transition-colors disabled:opacity-40 disabled:cursor-default rounded-lg";

export const inputCls =
  "flex-1 px-3 py-2 text-sm bg-[var(--card)] border border-[var(--border)] text-[var(--txt)] focus:border-[var(--accent)] focus:outline-none transition-colors rounded-lg";
