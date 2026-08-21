/**
 * NuPhy UI–based settings primitives for the cloud-only settings panel.
 *
 * Wraps @extrastu/nuphy-ui components with agent-surface instrumentation so
 * rows remain addressable from chat/voice (useAgentElement). The API mirrors
 * the shared settings-agent-rows but renders NuPhy's macOS-inspired controls
 * (IosToggle, SelectPill, Segmented, Slider, Button) instead of the legacy
 * Switch/Select/SegmentedGroup.
 */
import type { LucideIcon } from "lucide-react";
import * as React from "react";
import {
  Button as NuphyButton,
  IosToggle,
  Segmented,
  SelectPill,
  SettingRow as NuphySettingRow,
  SettingsGroup as NuphySettingsGroup,
  Slider as NuphySlider,
  Input as NuphyInput,
} from "@extrastu/nuphy-ui";
import { useAgentElement } from "../../../agent-surface";
import { cn } from "../../../lib/utils";

// Re-export the group and stack so sections can import everything from here.
export { NuphySettingsGroup as SettingsGroup };

export function SettingsStack({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-col gap-10", className)} {...props} />
  );
}

/**
 * A destructive-secondary button — looks like a secondary button (subtle fill
 * background) but with destructive-colored text and a destructive tint on
 * hover. Use for dangerous actions that shouldn't scream as loud as a full
 * destructive button (Disconnect, Remove, Revoke).
 */
export function DestructiveSecondaryButton({
  className,
  ...props
}: React.ComponentProps<typeof NuphyButton>) {
  return (
    <NuphyButton
      variant="secondary"
      className={cn(
        "bg-fill text-destructive",
        "hover:bg-destructive/10 active:bg-destructive/15",
        className,
      )}
      {...props}
    />
  );
}

function labelToString(label: React.ReactNode, fallback: string): string {
  return typeof label === "string" ? label : fallback;
}

// ── Switch row ──────────────────────────────────────────────────────────

export interface NuphySwitchRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  group?: string;
  agentStatus?: string;
  className?: string;
  testId?: string;
}

export function NuphySwitchRow({
  agentId,
  label,
  agentLabel,
  description,
  icon: Icon,
  iconClassName,
  checked,
  onCheckedChange,
  disabled = false,
  group = "settings",
  agentStatus,
  className,
  testId,
}: NuphySwitchRowProps) {
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
  const { "aria-label": _ignored, ...toggleAgentProps } = agentProps;

  return (
    <NuphySettingRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={
        typeof description === "string" ? description : undefined
      }
      control={
        <IosToggle
          id={agentId}
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          {...(toggleAgentProps as Record<string, unknown>)}
        />
      }
    />
  );
}

// ── Select row ──────────────────────────────────────────────────────────

export interface NuphySelectRowOption {
  value: string;
  label: string;
}

export interface NuphySelectRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: NuphySelectRowOption[];
  disabled?: boolean;
  group?: string;
  className?: string;
  testId?: string;
}

export function NuphySelectRow({
  agentId,
  label,
  agentLabel,
  description,
  icon: Icon,
  iconClassName,
  value,
  onValueChange,
  options,
  disabled = false,
  group = "settings",
  className,
  testId,
}: NuphySelectRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "select",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: value,
    getValue: () => value,
    onActivate: disabled ? undefined : () => {},
  });
  const { "aria-label": _ignored, ...selectAgentProps } = agentProps;

  return (
    <NuphySettingRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={
        typeof description === "string" ? description : undefined
      }
      control={
        <SelectPill
          options={options}
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          {...(selectAgentProps as Record<string, unknown>)}
        />
      }
    />
  );
}

// ── Segmented row ───────────────────────────────────────────────────────

export interface NuphySegmentedRowOption {
  value: string;
  label: string;
}

export interface NuphySegmentedRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  options: NuphySegmentedRowOption[];
  group?: string;
  className?: string;
}

export function NuphySegmentedRow({
  agentId,
  label,
  agentLabel,
  description,
  value,
  onValueChange,
  options,
  group = "settings",
}: NuphySegmentedRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
    id: agentId,
    role: "tab",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: value,
    getValue: () => value,
    onActivate: () => {},
  });

  return (
    <NuphySettingRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={
        typeof description === "string" ? description : undefined
      }
      control={
        <Segmented
          options={options}
          value={value}
          onValueChange={onValueChange}
          aria-label={resolvedLabel}
          {...agentProps}
        />
      }
    />
  );
}

// ── Slider row ──────────────────────────────────────────────────────────

export interface NuphySliderRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  unit?: string;
  disabled?: boolean;
  group?: string;
  className?: string;
}

export function NuphySliderRow({
  agentId,
  label,
  agentLabel,
  description,
  value,
  onValueChange,
  min,
  max,
  step,
  showValue = true,
  unit,
  disabled = false,
  group = "settings",
}: NuphySliderRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { agentProps } = useAgentElement<HTMLDivElement>({
    id: agentId,
    role: "slider",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: String(value),
    getValue: () => value,
    onActivate: disabled ? undefined : () => {},
  });

  return (
    <NuphySettingRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={
        typeof description === "string" ? description : undefined
      }
      control={
        <NuphySlider
          value={value}
          onValueChange={onValueChange}
          min={min}
          max={max}
          step={step}
          showValue={showValue}
          unit={unit}
          disabled={disabled}
          label={resolvedLabel}
          {...agentProps}
        />
      }
    />
  );
}

// ── Input row ───────────────────────────────────────────────────────────

export interface NuphyInputRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: React.InputHTMLAttributes<HTMLInputElement>["type"];
  group?: string;
  className?: string;
}

export function NuphyInputRow({
  agentId,
  label,
  agentLabel,
  description,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  type = "text",
  group = "settings",
}: NuphyInputRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: "text-input",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: value,
    getValue: () => value,
    onActivate: disabled ? undefined : () => {},
  });
  const { "aria-label": _ignored, ...inputAgentProps } = agentProps;

  return (
    <NuphySettingRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={
        typeof description === "string" ? description : undefined
      }
      control={
        <NuphyInput
          ref={ref as React.Ref<HTMLInputElement>}
          id={agentId}
          type={type}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          {...(inputAgentProps as Record<string, unknown>)}
        />
      }
    />
  );
}

// ── Action button row ───────────────────────────────────────────────────

export interface NuphyActionButtonProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  buttonLabel: React.ReactNode;
  onActivate: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
  group?: string;
  className?: string;
}

export function NuphyActionButton({
  agentId,
  label,
  agentLabel,
  description,
  buttonLabel,
  onActivate,
  disabled = false,
  variant = "secondary",
  size = "sm",
  group = "settings",
}: NuphyActionButtonProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: resolvedLabel,
    group,
    description: typeof description === "string" ? description : undefined,
    status: disabled ? "disabled" : "enabled",
    onActivate: disabled ? undefined : onActivate,
  });
  const { "aria-label": _ignored, ...btnAgentProps } = agentProps;

  return (
    <NuphySettingRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={
        typeof description === "string" ? description : undefined
      }
      control={
        <NuphyButton
          ref={ref}
          variant={variant}
          size={size}
          onClick={onActivate}
          disabled={disabled}
          {...(btnAgentProps as Record<string, unknown>)}
        >
          {buttonLabel}
        </NuphyButton>
      }
    />
  );
}

// ── Plain row (for custom content / non-standard controls) ──────────────

export interface NuphyRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  below?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function NuphyRow({
  label,
  description,
  control,
  children,
  below,
  className,
  ...rest
}: NuphyRowProps) {
  const effectiveControl = children ?? control ?? null;
  const labelIsString = typeof label === "string";
  const descIsString = typeof description === "string";

  // Fast path: plain string label/description → delegate to NuPhy SettingRow.
  if (labelIsString && descIsString && !below && !className) {
    return (
      <NuphySettingRow
        title={label}
        description={description}
        control={effectiveControl}
      />
    );
  }

  // General path: custom JSX label/description or extra props → render a
  // row that mirrors SettingRow's layout but accepts ReactNode.
  return (
    <div className={cn("py-4", className)} data-testid={rest["data-testid"]}>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-6 text-foreground">
            {label}
          </p>
          {description ? (
            <div className="mt-0.5 text-[13px] leading-5 text-muted-foreground text-pretty">
              {description}
            </div>
          ) : null}
        </div>
        {effectiveControl ? (
          <div className="shrink-0">{effectiveControl}</div>
        ) : null}
      </div>
      {below}
    </div>
  );
}
