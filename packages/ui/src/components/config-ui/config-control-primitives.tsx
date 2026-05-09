import { cn } from "@elizaos/ui";

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
    "w-full border border-border bg-card font-[var(--mono)] box-border transition-[border-color,box-shadow,background-color] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted placeholder:opacity-60",
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
    "w-full border border-border bg-card font-[var(--mono)] box-border transition-[border-color,box-shadow,background-color] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y",
    density === "compact"
      ? "min-h-16 px-2 py-1 text-xs"
      : "min-h-[72px] max-h-[400px] rounded-sm px-3 py-2 text-sm",
    hasError
      ? "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]"
      : null,
    className,
  );
}

export function ConfigFieldErrors({
  errors,
}: {
  errors?: readonly string[] | undefined;
}) {
  if (!errors?.length) {
    return null;
  }

  return (
    <div className="flex flex-col gap-0.5">
      {errors.map((err) => (
        <span key={err} className="text-2xs text-destructive">
          {err}
        </span>
      ))}
    </div>
  );
}
