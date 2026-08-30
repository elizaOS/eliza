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
import { SegmentedControl } from "../ui/segmented-control";
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
  /** Explicit accessible name when an adapter must preserve a legacy label. */
  controlAriaLabel?: string;
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
  /** Stable test hook on the switch control. */
  testId?: string;
}

export function SettingsSwitchRow({
  agentId,
  label,
  agentLabel,
  controlAriaLabel,
  description,
  icon,
  iconClassName,
  checked,
  onCheckedChange,
  disabled = false,
  group = "settings",
  agentStatus,
  className,
  testId,
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
  const { "aria-label": _ignoredSwitchAccessibleName, ...switchAgentProps } =
    agentProps;

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
          aria-label={controlAriaLabel}
          data-testid={testId}
          {...switchAgentProps}
        />
      }
    />
  );
}

export interface SettingsSelectRowOption {
  value: string;
  label: React.ReactNode;
  hint?: string;
  /** Plain-text typeahead value. Defaults to a string label; omitted for JSX. */
  textValue?: string;
}

export interface SettingsSelectRowGroup {
  label: string;
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
  options?: SettingsSelectRowOption[];
  groups?: SettingsSelectRowGroup[];
  placeholder?: string;
  disabled?: boolean;
  group?: string;
  triggerClassName?: string;
  contentClassName?: string;
  /** Trailing control kept with the select (preview, merge, etc.). */
  trailing?: React.ReactNode;
  /** Stack the trailing control under the select until `sm`. */
  trailingStackUntilSm?: boolean;
  testId?: string;
}

function flattenSelectOptions(
  options: SettingsSelectRowOption[] | undefined,
  groups: SettingsSelectRowGroup[] | undefined,
): SettingsSelectRowOption[] {
  if (groups && groups.length > 0) {
    return groups.flatMap((group) => group.items);
  }
  return options ?? [];
}

function renderSelectOption(option: SettingsSelectRowOption) {
  const textValue =
    option.textValue ??
    (typeof option.label === "string" ? option.label : undefined);
  return (
    <SelectItem key={option.value} value={option.value} textValue={textValue}>
      {option.hint ? (
        <div className="flex w-full items-center justify-between gap-2">
          <span className="font-semibold">{option.label}</span>
          <span className="text-muted text-xs">{option.hint}</span>
        </div>
      ) : (
        option.label
      )}
    </SelectItem>
  );
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
  groups,
  placeholder,
  disabled = false,
  group = "settings",
  triggerClassName,
  contentClassName,
  trailing,
  trailingStackUntilSm = false,
  testId,
}: SettingsSelectRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const flattened = flattenSelectOptions(options, groups);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "select",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: value || undefined,
    options: flattened.map((option) => option.value),
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });
  const { "aria-label": _ignoredSelectAccessibleName, ...selectAgentProps } =
    agentProps;

  const select = (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SettingsSelectTrigger
        ref={ref}
        id={agentId}
        variant="touch"
        className={cn(trailing && "min-w-0 flex-1", triggerClassName)}
        data-testid={testId}
        {...selectAgentProps}
      >
        <SelectValue placeholder={placeholder} />
      </SettingsSelectTrigger>
      <SelectContent className={contentClassName}>
        {groups && groups.length > 0
          ? groups.map((optionGroup) => (
              <SelectGroup key={optionGroup.label}>
                <SelectLabel className="px-2.5 py-1 text-2xs font-semibold text-muted">
                  {optionGroup.label}
                </SelectLabel>
                {optionGroup.items.map(renderSelectOption)}
              </SelectGroup>
            ))
          : flattened.map(renderSelectOption)}
      </SelectContent>
    </Select>
  );

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      description={description}
      htmlFor={agentId}
      stacked
    >
      {trailing ? (
        <div
          className={
            trailingStackUntilSm
              ? "grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
              : "flex items-center gap-2"
          }
        >
          {select}
          {trailing}
        </div>
      ) : (
        select
      )}
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
      <div
        ref={ref}
        role="radiogroup"
        aria-label={resolvedLabel}
        data-testid={testId}
        className={cn("w-full", className)}
        {...agentProps}
      >
        <SegmentedControl
          className="w-full"
          value={value}
          onValueChange={onValueChange}
          items={options.map((option) => ({
            ...option,
            disabled,
            agentId: `${agentId}-${option.value}`,
            agentGroup: group,
          }))}
          buttonClassName="flex-1"
        />
      </div>
    </SettingsRow>
  );
}

export interface SettingsInputRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  /** Field help rendered under the input, not under the label. */
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
  /** Marks the field invalid for assistive tech and danger styling. */
  invalid?: boolean;
  /** Validation error announced below the field. Implies invalid. */
  error?: React.ReactNode;
  /** Optional stable test id applied to the input. */
  testId?: string;
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
  invalid = false,
  error,
  testId,
  className,
  inputClassName,
}: SettingsInputRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const showError = Boolean(error);
  const isInvalid = invalid || showError;
  const errorId = `${agentId}-error`;
  const helpId = description ? `${agentId}-help` : undefined;
  const describedBy = [helpId, showError ? errorId : undefined]
    .filter(Boolean)
    .join(" ");
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: type === "number" ? "number-input" : "text-input",
    label: resolvedLabel,
    group,
    description:
      typeof error === "string"
        ? error
        : typeof description === "string"
          ? description
          : undefined,
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });
  const { "aria-label": _ignoredAccessibleName, ...rowAgentProps } = agentProps;

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      className={className}
      htmlFor={agentId}
      stacked
    >
      <SettingsInput
        ref={ref}
        id={agentId}
        variant={variant}
        type={type}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy || undefined}
        data-testid={testId}
        hasError={isInvalid}
        className={inputClassName}
        {...rowAgentProps}
      />
      {description ? (
        <p id={helpId} className="mt-1 text-xs leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
      {showError ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

export interface SettingsTextareaRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  /** Field help rendered under the textarea, not under the label. */
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
  const helpId = description ? `${agentId}-help` : undefined;
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: agentId,
    role: "textarea",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    getValue: () => value,
    onFill: disabled ? undefined : (next: string) => onValueChange(next),
  });

  const {
    "aria-label": _ignoredTextareaAccessibleName,
    ...textareaAgentProps
  } = agentProps;

  return (
    <SettingsRow
      icon={icon}
      iconClassName={iconClassName}
      label={label}
      className={className}
      htmlFor={agentId}
      stacked
    >
      <SettingsTextarea
        ref={ref}
        id={agentId}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        aria-describedby={helpId}
        className={textareaClassName}
        {...textareaAgentProps}
      />
      {description ? (
        <p id={helpId} className="mt-1 text-xs leading-relaxed text-muted">
          {description}
        </p>
      ) : null}
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
