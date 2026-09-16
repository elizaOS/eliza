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

export interface SettingsSelectTriggerProps
  extends Omit<
    React.ComponentPropsWithoutRef<typeof SelectTrigger>,
    "variant"
  > {
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
      variant={
        variant === "touch"
          ? "settingsTouch"
          : variant === "filter"
            ? "settingsFilter"
            : variant === "soft"
              ? "settingsSoft"
              : variant === "toolbar"
                ? "settingsToolbar"
                : "settingsCompact"
      }
      className={className}
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
      variant={
        variant === "touch"
          ? "settingsTouch"
          : variant === "filter"
            ? "settingsFilter"
            : "settingsCompact"
      }
      density={
        variant === "touch"
          ? "relaxed"
          : variant === "filter"
            ? "default"
            : "short"
      }
      className={className}
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
    <Textarea ref={ref} variant="settings" className={className} {...props} />
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
