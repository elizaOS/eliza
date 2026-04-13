import { Field, FieldDescription, FieldLabel, cn } from "@elizaos/app-core";
import * as React from "react";

export const SETTINGS_COMPACT_SELECT_TRIGGER_CLASSNAME =
  "h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";

export const SETTINGS_SOFT_SELECT_TRIGGER_CLASSNAME =
  "rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";

export const SETTINGS_COMPACT_INPUT_CLASSNAME =
  "h-9 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";

export const SETTINGS_FILTER_CONTROL_CLASSNAME =
  "h-10 rounded-xl border-border/50 bg-bg/80 text-sm text-txt shadow-sm";

export const SETTINGS_SEGMENTED_GROUP_CLASSNAME =
  "flex gap-1 rounded-xl border border-border bg-card/50 p-1 shrink-0";

export const SETTINGS_TEXTAREA_CLASSNAME =
  "w-full rounded-xl border border-border/60 bg-bg/55 px-3 py-2 text-xs-tight font-mono shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";

export const SETTINGS_TOOLBAR_SELECT_TRIGGER_CLASSNAME =
  "h-11 rounded-xl border-border/60 bg-bg/70 text-left shadow-sm";

export const SETTINGS_MUTED_TEXT_CLASSNAME = "text-xs-tight text-muted";

export function SettingsField({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <Field className={cn("gap-1.5", className)} {...props} />;
}

export function SettingsFieldLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof FieldLabel>) {
  return (
    <FieldLabel
      className={cn("text-xs font-semibold text-txt", className)}
      {...props}
    />
  );
}

export function SettingsFieldDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof FieldDescription>) {
  return (
    <FieldDescription
      className={cn(SETTINGS_MUTED_TEXT_CLASSNAME, className)}
      {...props}
    />
  );
}
