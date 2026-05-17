import type * as React from "react";
import { FieldDescription, FieldLabel } from "../ui/field";
export declare function SettingsField({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): import("react/jsx-runtime").JSX.Element;
export declare function SettingsFieldLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof FieldLabel
>): import("react/jsx-runtime").JSX.Element;
export declare function SettingsFieldDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<
  typeof FieldDescription
>): import("react/jsx-runtime").JSX.Element;
export interface UseSettingsSaveOptions {
  onSave: () => Promise<void> | void;
  successMs?: number;
  errorFallback?: string;
}
export interface UseSettingsSaveResult {
  saving: boolean;
  saveError: string | null;
  saveSuccess: boolean;
  handleSave: () => Promise<void>;
  resetStatus: () => void;
}
export declare function useSettingsSave(
  options: UseSettingsSaveOptions,
): UseSettingsSaveResult;
export declare function AdvancedSettingsDisclosure({
  title,
  children,
  className,
  lazy,
  defaultOpen,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  lazy?: boolean;
  defaultOpen?: boolean;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=settings-control-primitives.d.ts.map
