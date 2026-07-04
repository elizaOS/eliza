/**
 * Tailwind class builders for config-form input and textarea controls, shared by
 * `ConfigRenderer`'s field renderers and `UiRenderer`. Centralizes the density
 * (compact/regular) and error-state styling so every config control looks the same.
 */
import { cn } from "../../lib/utils";

export function getConfigInputClassName({
  className,
  density = "regular",
  hasError = false,
}: {
  className?: string;
  density?: "compact" | "regular";
  hasError?: boolean;
}) {
  return cn(
    "w-full border border-border bg-card font-[var(--mono)] box-border transition-[border-color,box-shadow,background-color]     placeholder:text-muted placeholder:opacity-60",
    density === "compact"
      ? "h-8 px-2 py-1 text-xs"
      : "h-9 rounded-sm px-3 py-2 text-sm",
    hasError
      ? "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]"
      : null,
    className,
  );
}

export function getConfigTextareaClassName({
  className,
  density = "regular",
  hasError = false,
}: {
  className?: string;
  density?: "compact" | "regular";
  hasError?: boolean;
}) {
  return cn(
    "w-full border border-border bg-card font-[var(--mono)] box-border transition-[border-color,box-shadow,background-color]     resize-y",
    density === "compact"
      ? "min-h-16 px-2 py-1 text-xs"
      : "min-h-[72px] max-h-[400px] rounded-sm px-3 py-2 text-sm",
    hasError
      ? "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]"
      : null,
    className,
  );
}
