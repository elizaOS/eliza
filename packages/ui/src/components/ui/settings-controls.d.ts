import type * as React from "react";
import { FieldDescription, FieldLabel } from "./field";
import { type InputProps } from "./input";
import { SelectTrigger } from "./select";
import { type TextareaProps } from "./textarea";
export type SettingsSelectTriggerVariant =
  | "compact"
  | "filter"
  | "soft"
  | "toolbar";
export type SettingsInputVariant = "compact" | "filter";
export interface SettingsSelectTriggerProps
  extends React.ComponentPropsWithoutRef<typeof SelectTrigger> {
  variant?: SettingsSelectTriggerVariant;
  className?: string;
  children?: React.ReactNode;
}
export declare function SettingsSelectTrigger({
  className,
  variant,
  ...props
}: SettingsSelectTriggerProps): import("react/jsx-runtime").JSX.Element;
export interface SettingsInputProps extends Omit<InputProps, "variant"> {
  variant?: SettingsInputVariant;
}
export declare function SettingsInput({
  className,
  variant,
  ...props
}: SettingsInputProps): import("react/jsx-runtime").JSX.Element;
export interface SettingsTextareaProps extends TextareaProps {}
export declare function SettingsTextarea({
  className,
  ...props
}: SettingsTextareaProps): import("react/jsx-runtime").JSX.Element;
export interface SettingsSegmentedGroupProps
  extends React.HTMLAttributes<HTMLDivElement> {}
export declare function SettingsSegmentedGroup({
  className,
  ...props
}: SettingsSegmentedGroupProps): import("react/jsx-runtime").JSX.Element;
export interface SettingsMutedTextProps
  extends React.HTMLAttributes<HTMLDivElement> {}
export declare function SettingsMutedText({
  className,
  ...props
}: SettingsMutedTextProps): import("react/jsx-runtime").JSX.Element;
declare function SettingsField({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): import("react/jsx-runtime").JSX.Element;
declare function SettingsFieldLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof FieldLabel
>): import("react/jsx-runtime").JSX.Element;
declare function SettingsFieldDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof FieldDescription
>): import("react/jsx-runtime").JSX.Element;
export declare const SettingsControls: {
  Input: typeof SettingsInput;
  SelectTrigger: typeof SettingsSelectTrigger;
  Textarea: typeof SettingsTextarea;
  SegmentedGroup: typeof SettingsSegmentedGroup;
  MutedText: typeof SettingsMutedText;
  Field: typeof SettingsField;
  FieldLabel: typeof SettingsFieldLabel;
  FieldDescription: typeof SettingsFieldDescription;
};
//# sourceMappingURL=settings-controls.d.ts.map
