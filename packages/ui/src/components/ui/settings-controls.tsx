/**
 * Settings-form control skins that wrap the Field/Input/Select/Textarea
 * primitives with the compact variants used across settings and config panels,
 * so each panel doesn't re-derive the same trigger/label styling.
 */
import * as React from "react";

import { cn } from "../../lib/utils";
import { Field, FieldDescription, FieldLabel } from "./field";
import { Input, type InputProps } from "./input";
import { SelectTrigger } from "./select";
import { Textarea, type TextareaProps } from "./textarea";

export type SettingsSelectTriggerVariant =
  | "compact"
  | "filter"
  | "soft"
  | "toolbar"
  | "touch";

export type SettingsInputVariant = "compact" | "filter" | "touch";

// 44px-tall, finger-friendly control. This is the default vocabulary for the
// redesigned settings surface — every editable control inside a SettingsRow
// uses the "touch" variant so mobile editing has real tap targets.
const TOUCH_CONTROL_CLASS =
  "h-11 rounded-md border border-border bg-card px-3.5 text-sm text-txt transition-[border-color,box-shadow,background-color]   ";

function settingsSelectTriggerClassName(
  variant: SettingsSelectTriggerVariant,
): string {
  switch (variant) {
    case "touch":
      return `${TOUCH_CONTROL_CLASS} text-left`;
    case "filter":
      return "h-10 rounded-sm border border-border/50 bg-bg/80 px-3 py-2 text-left text-sm text-txt transition-[border-color,box-shadow,background-color]   ";
    case "soft":
      return "rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs transition-[border-color,box-shadow,background-color]   ";
    case "toolbar":
      return "h-11 rounded-sm border-border/60 bg-bg/70 text-left ";
    default:
      return "h-9 rounded-sm border border-border bg-card px-2.5 py-1.5 text-xs transition-[border-color,box-shadow,background-color]   ";
  }
}

function settingsInputClassName(variant: SettingsInputVariant): string {
  switch (variant) {
    case "touch":
      return TOUCH_CONTROL_CLASS;
    case "filter":
      return "h-10 rounded-sm border-border/50 bg-bg/80 text-sm text-txt ";
    default:
      return "h-9 rounded-sm border border-border bg-card px-3 py-2 text-xs transition-[border-color,box-shadow,background-color]   ";
  }
}

export interface SettingsSelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectTrigger> {
  variant?: SettingsSelectTriggerVariant;
  className?: string;
  children?: React.ReactNode;
}

export const SettingsSelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectTrigger>,
  SettingsSelectTriggerProps
>(function SettingsSelectTrigger(
  { className, variant = "compact", ...props },
  ref,
) {
  return (
    <SelectTrigger
      ref={ref}
      className={cn(settingsSelectTriggerClassName(variant), className)}
      {...props}
    />
  );
});

export interface SettingsInputProps extends Omit<InputProps, "variant"> {
  variant?: SettingsInputVariant;
}

export const SettingsInput = React.forwardRef<
  HTMLInputElement,
  SettingsInputProps
>(function SettingsInput({ className, variant = "compact", ...props }, ref) {
  return (
    <Input
      ref={ref}
      className={cn(settingsInputClassName(variant), className)}
      {...props}
    />
  );
});

export interface SettingsTextareaProps extends TextareaProps {}

export const SettingsTextarea = React.forwardRef<
  HTMLTextAreaElement,
  SettingsTextareaProps
>(function SettingsTextarea({ className, ...props }, ref) {
  return (
    <Textarea
      ref={ref}
      className={cn(
        "w-full rounded-sm border border-border/60 bg-bg/55 px-3 py-2 text-xs-tight font-mono transition-[border-color,box-shadow,background-color]   ",
        className,
      )}
      {...props}
    />
  );
});

export interface SettingsSegmentedGroupProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export const SettingsSegmentedGroup = React.forwardRef<
  HTMLDivElement,
  SettingsSegmentedGroupProps
>(function SettingsSegmentedGroup({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        "flex shrink-0 gap-1 rounded-sm border border-border bg-card/50 p-1",
        className,
      )}
      {...props}
    />
  );
});

export interface SettingsMutedTextProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function SettingsMutedText({
  className,
  ...props
}: SettingsMutedTextProps) {
  return (
    <div className={cn("text-xs-tight text-muted", className)} {...props} />
  );
}

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
      className={cn("text-xs-tight text-muted", className)}
      {...props}
    />
  );
}

export const SettingsControls = {
  Input: SettingsInput,
  SelectTrigger: SettingsSelectTrigger,
  Textarea: SettingsTextarea,
  SegmentedGroup: SettingsSegmentedGroup,
  MutedText: SettingsMutedText,
  Field: SettingsField,
  FieldLabel: SettingsFieldLabel,
  FieldDescription: SettingsFieldDescription,
};
