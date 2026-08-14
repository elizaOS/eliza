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

import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../agent-surface";
import { cn } from "../../lib/utils";
import { Button, type ButtonProps } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectValue,
} from "../ui/select";
import {
  SettingsInput,
  type SettingsInputVariant,
  SettingsSegmentedGroup,
  SettingsSelectTrigger,
  SettingsTextarea,
} from "../ui/settings-controls";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settings-layout";

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
  /** Override the agent-surface status token (defaults to on/off). */
  agentStatus?: string;
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
  agentStatus,
  className,
}: SettingsSwitchRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "toggle",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: agentStatus ?? (checked ? "on" : "off"),
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
      htmlFor={agentId}
      control={
        <Switch
          ref={ref}
          id={agentId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          {...agentProps}
          aria-label={resolvedLabel}
          aria-checked={checked}
        />
      }
    />
  );
}

export interface SettingsSelectRowOption {
  value: string;
  label: React.ReactNode;
  /** Optional descriptive text below the label. */
  hint?: React.ReactNode;
}

export interface SettingsSelectRowGroup {
  label: React.ReactNode;
  items: SettingsSelectRowOption[];
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
  /** Flat options array. For grouped options, use `optionGroups` instead. */
  options?: SettingsSelectRowOption[];
  /** Grouped options. Mutually exclusive with `options`. */
  optionGroups?: SettingsSelectRowGroup[];
  placeholder?: string;
  disabled?: boolean;
  group?: string;
  triggerClassName?: string;
  /** Optional data-testid for the select trigger. */
  testId?: string;
  /** Optional trailing action button (e.g. preview, test). */
  trailingAction?: {
    node: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
  };
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
  optionGroups,
  placeholder,
  disabled = false,
  group = "settings",
  triggerClassName,
  testId,
  trailingAction,
}: SettingsSelectRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);

  // Flatten options for agent surface
  const flatOptions = optionGroups
    ? optionGroups.flatMap((g) => g.items.map((item) => item.value))
    : (options?.map((option) => option.value) ?? []);

  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "select",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: value || undefined,
    options: flatOptions,
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });

  const selectContent = (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SettingsSelectTrigger
        ref={ref}
        variant="touch"
        className={triggerClassName}
        aria-label={resolvedLabel}
        data-testid={testId}
        {...agentProps}
      >
        <SelectValue placeholder={placeholder} />
      </SettingsSelectTrigger>
      <SelectContent>
        {optionGroups
          ? optionGroups.map((optGroup) => (
              <SelectGroup key={typeof optGroup.label === "string" ? optGroup.label : "group"}>
                <SelectLabel className="px-2.5 py-1 text-2xs font-semibold text-muted">
                  {optGroup.label}
                </SelectLabel>
                {optGroup.items.map((item) => (
                  <SelectItem
                    key={item.value}
                    value={item.value}
                    textValue={typeof item.label === "string" ? item.label : item.value}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="font-semibold">{item.label}</span>
                      {item.hint ? (
                        <span className="text-muted text-xs">{item.hint}</span>
                      ) : null}
                    </div>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))
          : options?.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="font-semibold">{option.label}</span>
                  {option.hint ? (
                    <span className="text-muted text-xs">{option.hint}</span>
                  ) : null}
                </div>
              </SelectItem>
            ))}
      </SelectContent>
    </Select>
  );

  if (trailingAction) {
    return (
      <SettingsRow
        icon={icon}
        iconClassName={iconClassName}
        label={label}
        description={description}
        stacked
      >
        <div className="flex items-center gap-2">
          {selectContent}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-md"
            onClick={trailingAction.onClick}
            disabled={trailingAction.disabled ?? disabled}
          >
            {trailingAction.node}
          </Button>
        </div>
      </SettingsRow>
    );
  }

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      description={description}
      stacked
    >
      {selectContent}
    </SettingsRow>
  );
}

export interface SettingsSegmentedRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SettingsSelectRowOption[];
  disabled?: boolean;
  group?: string;
  className?: string;
  /** Optional stable test id, applied to the segmented group container. */
  testId?: string;
}

/**
 * A segmented control for a small, fixed set of options (≈2–4). All choices are
 * visible at once — no OS picker, no "options a whole page away" on mobile —
 * and the whole control is agent-addressable (`role: "select"`) just like
 * {@link SettingsSelectRow}. Prefer this over {@link SettingsSelectRow} when the
 * option set is small and stable (e.g. local/cloud strategy, on/off/auto).
 */
export function SettingsSegmentedRow({
  agentId,
  label,
  agentLabel,
  description,
  icon,
  iconClassName,
  value,
  onValueChange,
  options,
  disabled = false,
  group = "settings",
  className,
  testId,
}: SettingsSegmentedRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
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
      <SettingsSegmentedGroup
        ref={ref}
        role="radiogroup"
        aria-label={resolvedLabel}
        data-testid={testId}
        className={cn("w-full", className)}
        {...agentProps}
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Button
              key={option.value}
              role="radio"
              aria-checked={active}
              data-value={option.value}
              data-active={active ? "true" : "false"}
              disabled={disabled}
              onClick={() => onValueChange(option.value)}
              variant="ghost"
              size="sm"
              className={cn(
                "h-9 flex-1 rounded-sm px-2 text-xs font-medium transition-colors disabled:opacity-50",
                active
                  ? "bg-card text-txt-strong"
                  : "text-muted hover:bg-card/60 hover:text-txt",
              )}
            >
              {option.label}
            </Button>
          );
        })}
      </SettingsSegmentedGroup>
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
  /** Optional data-testid for the input element. */
  testId?: string;
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
  testId,
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
        data-testid={testId}
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
