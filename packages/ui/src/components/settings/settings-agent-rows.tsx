import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import { Button, type ButtonProps } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import {
  SettingsInput,
  type SettingsInputVariant,
  SettingsSelectTrigger,
  SettingsTextarea,
} from "../ui/settings-controls";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settings-layout";

/**
 * Agent-addressable settings controls.
 *
 * These pair a {@link SettingsRow} with a control that registers itself on the
 * active view's agent surface (`useAgentElement`). Because the Settings view is
 * itself an agent surface (`ShellViewAgentSurface viewId="settings"`), any row
 * built with these is editable straight from chat/voice — the agent can
 * `list-elements` and `agent-click` / `agent-fill` them with no extra plumbing.
 *
 * Use these instead of a bare `SettingsRow + Switch/Select` whenever the setting
 * should be configurable from chat (which is the default for settings).
 */

function labelToString(label: React.ReactNode, fallback: string): string {
  return typeof label === "string" ? label : fallback;
}

export interface SettingsSwitchRowProps {
  /** Stable agent id, unique within the settings view (e.g. "toggle-dark"). */
  agentId: string;
  label: React.ReactNode;
  /** What the user would say to target it (defaults to the label). */
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Agent-surface grouping key. */
  group?: string;
  className?: string;
}

export function SettingsSwitchRow({
  agentId,
  label,
  agentLabel,
  description,
  icon,
  iconClassName,
  checked,
  onCheckedChange,
  disabled = false,
  group = "settings",
  className,
}: SettingsSwitchRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "toggle",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: checked ? "on" : "off",
    getValue: () => checked,
    onActivate: disabled ? undefined : () => onCheckedChange(!checked),
  });

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      description={description}
      className={className}
      control={
        <Switch
          ref={ref}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-label={resolvedLabel}
          {...agentProps}
        />
      }
    />
  );
}

export interface SettingsSelectRowOption {
  value: string;
  label: React.ReactNode;
}

export interface SettingsSelectRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SettingsSelectRowOption[];
  placeholder?: string;
  disabled?: boolean;
  group?: string;
  triggerClassName?: string;
}

export function SettingsSelectRow({
  agentId,
  label,
  agentLabel,
  description,
  icon,
  iconClassName,
  value,
  onValueChange,
  options,
  placeholder,
  disabled = false,
  group = "settings",
  triggerClassName,
}: SettingsSelectRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "select",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: value || undefined,
    options: options.map((option) => option.value),
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      description={description}
      stacked
    >
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SettingsSelectTrigger
          ref={ref}
          variant="touch"
          className={triggerClassName}
          aria-label={resolvedLabel}
          {...agentProps}
        >
          <SelectValue placeholder={placeholder} />
        </SettingsSelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

export interface SettingsInputRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "password" | "url" | "email";
  inputMode?: React.InputHTMLAttributes<HTMLInputElement>["inputMode"];
  autoComplete?: string;
  variant?: SettingsInputVariant;
  disabled?: boolean;
  group?: string;
  className?: string;
  inputClassName?: string;
}

/** A labelled text/number field that the agent can read and fill from chat. */
export function SettingsInputRow({
  agentId,
  label,
  agentLabel,
  description,
  icon,
  iconClassName,
  value,
  onValueChange,
  placeholder,
  type = "text",
  inputMode,
  autoComplete,
  variant = "touch",
  disabled = false,
  group = "settings",
  className,
  inputClassName,
}: SettingsInputRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: type === "number" ? "number-input" : "text-input",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      description={description}
      className={className}
      stacked
    >
      <SettingsInput
        ref={ref}
        variant={variant}
        type={type}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-label={resolvedLabel}
        className={inputClassName}
        {...agentProps}
      />
    </SettingsRow>
  );
}

export interface SettingsTextareaRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  group?: string;
  className?: string;
  textareaClassName?: string;
}

/** A labelled multi-line field the agent can read and fill from chat. */
export function SettingsTextareaRow({
  agentId,
  label,
  agentLabel,
  description,
  icon,
  iconClassName,
  value,
  onValueChange,
  placeholder,
  rows = 4,
  disabled = false,
  group = "settings",
  className,
  textareaClassName,
}: SettingsTextareaRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: agentId,
    role: "textarea",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      description={description}
      className={className}
      stacked
    >
      <SettingsTextarea
        ref={ref}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-label={resolvedLabel}
        className={textareaClassName}
        {...agentProps}
      />
    </SettingsRow>
  );
}

export interface SettingsActionButtonProps extends ButtonProps {
  /** Stable agent id, unique within the settings view. */
  agentId: string;
  /** What the user would say to target it (defaults to text children). */
  agentLabel?: string;
  /** Status token rendered as `data-state` (e.g. "loading", "saved"). */
  agentStatus?: string;
  agentGroup?: string;
  agentDescription?: string;
}

/**
 * A styled action button that registers on the agent surface, so chat can
 * trigger it ("save", "refresh", "connect"). Drop-in for any settings button.
 */
export const SettingsActionButton = React.forwardRef<
  HTMLButtonElement,
  SettingsActionButtonProps
>(function SettingsActionButton(
  {
    agentId,
    agentLabel,
    agentStatus,
    agentGroup = "settings",
    agentDescription,
    onClick,
    disabled,
    children,
    ...rest
  },
  forwardedRef,
) {
  const resolvedLabel =
    agentLabel ?? (typeof children === "string" ? children : agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: resolvedLabel,
    group: agentGroup,
    description: agentDescription,
    status: agentStatus,
    onActivate:
      disabled || !onClick
        ? undefined
        : () => onClick({} as React.MouseEvent<HTMLButtonElement>),
  });
  return (
    <Button
      ref={mergeRefs(ref, forwardedRef)}
      onClick={onClick}
      disabled={disabled}
      aria-label={resolvedLabel}
      {...agentProps}
      {...rest}
    >
      {children}
    </Button>
  );
});

function mergeRefs<T>(
  ...refs: Array<React.Ref<T> | undefined>
): React.RefCallback<T> {
  return (value: T | null) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(value);
      else if (ref && typeof ref === "object") {
        (ref as React.MutableRefObject<T | null>).current = value;
      }
    }
  };
}
