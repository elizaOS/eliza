import type * as React from "react";

import { cn } from "../../lib/utils";
import { Field, FieldDescription, FieldLabel } from "./field";
import { Input, type InputProps } from "./input";
import { SelectTrigger } from "./select";
import { Textarea, type TextareaProps } from "./textarea";

export type SettingsSelectTriggerVariant =
  | "compact"
  | "filter"
  | "soft"
  | "toolbar";

export type SettingsInputVariant = "compact" | "filter";

function settingsSelectTriggerClassName(
  variant: SettingsSelectTriggerVariant,
): string {
  switch (variant) {
    case "filter":
      return "h-10 rounded-xl border border-border/50 bg-bg/80 px-3 py-2 text-left text-sm text-txt shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";
    case "soft":
      return "rounded-lg border border-border bg-bg px-2.5 py-1.5 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";
    case "toolbar":
      return "h-11 rounded-xl border-border/60 bg-bg/70 text-left shadow-sm";
    default:
      return "h-9 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";
  }
}

function settingsInputClassName(variant: SettingsInputVariant): string {
  switch (variant) {
    case "filter":
      return "h-10 rounded-xl border-border/50 bg-bg/80 text-sm text-txt shadow-sm";
    default:
      return "h-9 rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent";
  }
}

export interface SettingsSelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectTrigger> {
  variant?: SettingsSelectTriggerVariant;
  className?: string;
  children?: React.ReactNode;
}

export function SettingsSelectTrigger({
  className,
  variant = "compact",
  ...props
}: SettingsSelectTriggerProps) {
  return (
    <SelectTrigger
      className={cn(settingsSelectTriggerClassName(variant), className)}
      {...props}
    />
  );
}

export interface SettingsInputProps extends Omit<InputProps, "variant"> {
  variant?: SettingsInputVariant;
}

export function SettingsInput({
  className,
  variant = "compact",
  ...props
}: SettingsInputProps) {
  return (
    <Input
      className={cn(settingsInputClassName(variant), className)}
      {...props}
    />
  );
}

export interface SettingsTextareaProps extends TextareaProps {}

export function SettingsTextarea({
  className,
  ...props
}: SettingsTextareaProps) {
  return (
    <Textarea
      className={cn(
        "w-full rounded-xl border border-border/60 bg-bg/55 px-3 py-2 text-xs-tight font-mono shadow-sm transition-[border-color,box-shadow,background-color] focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent",
        className,
      )}
      {...props}
    />
  );
}

export interface SettingsSegmentedGroupProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function SettingsSegmentedGroup({
  className,
  ...props
}: SettingsSegmentedGroupProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 gap-1 rounded-xl border border-border bg-card/50 p-1",
        className,
      )}
      {...props}
    />
  );
}

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

function SettingsField({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <Field className={cn("gap-1.5", className)} {...props} />;
}

function SettingsFieldLabel({
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

function SettingsFieldDescription({
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
