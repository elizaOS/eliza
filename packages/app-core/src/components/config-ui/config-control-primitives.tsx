import { cn } from "@elizaos/app-core";

export const CONFIG_FIELD_LABEL_CLASSNAME = "text-xs font-semibold";
export const CONFIG_FIELD_ERROR_TEXT_CLASSNAME = "text-2xs text-destructive";

const CONFIG_CONTROL_BASE_CLASSNAME =
  "w-full border border-border bg-card font-[var(--mono)] box-border transition-[border-color,box-shadow,background-color] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-muted placeholder:opacity-60";
const CONFIG_CONTROL_ERROR_CLASSNAME =
  "border-destructive bg-[color-mix(in_srgb,var(--destructive)_3%,var(--card))]";
const CONFIG_CONTROL_COMPACT_CLASSNAME = "h-8 px-2 py-1 text-xs";
const CONFIG_CONTROL_REGULAR_CLASSNAME = "h-9 rounded-sm px-3 py-2 text-sm";

const CONFIG_TEXTAREA_BASE_CLASSNAME =
  "w-full border border-border bg-card font-[var(--mono)] box-border transition-[border-color,box-shadow,background-color] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y";
const CONFIG_TEXTAREA_COMPACT_CLASSNAME = "min-h-16 px-2 py-1 text-xs";
const CONFIG_TEXTAREA_REGULAR_CLASSNAME =
  "min-h-[72px] max-h-[400px] rounded-sm px-3 py-2 text-sm";

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
    CONFIG_CONTROL_BASE_CLASSNAME,
    density === "compact"
      ? CONFIG_CONTROL_COMPACT_CLASSNAME
      : CONFIG_CONTROL_REGULAR_CLASSNAME,
    hasError ? CONFIG_CONTROL_ERROR_CLASSNAME : null,
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
    CONFIG_TEXTAREA_BASE_CLASSNAME,
    density === "compact"
      ? CONFIG_TEXTAREA_COMPACT_CLASSNAME
      : CONFIG_TEXTAREA_REGULAR_CLASSNAME,
    hasError ? CONFIG_CONTROL_ERROR_CLASSNAME : null,
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
        <span key={err} className={CONFIG_FIELD_ERROR_TEXT_CLASSNAME}>
          {err}
        </span>
      ))}
    </div>
  );
}
