/**
 * Settings primitives for the cloud-only settings panel, rendered entirely
 * with the package's canonical controls (Switch, Slider, SegmentedControl,
 * FormSelect, Button, Dialog) on Eliza brand tokens. Rows keep agent-surface
 * instrumentation (useAgentElement) so they remain addressable from
 * chat/voice.
 */

import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import * as React from "react";
import { useAgentElement } from "../../../agent-surface";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";
import { FormSelect, FormSelectItem } from "../../ui/form-select";
import { SegmentedControl } from "../../ui/segmented-control";
import { Slider } from "../../ui/slider";
import { Switch } from "../../ui/switch";

interface SettingsGroupProps {
  children: React.ReactNode;
  title?: string;
  footer?: string;
  className?: string;
}

/** Groups settings rows with one consistent inset hairline between siblings. */
export function SettingsGroup({
  children,
  title,
  footer,
  className,
}: SettingsGroupProps) {
  return (
    <section className={className}>
      {title ? (
        <h2 className="mb-3 px-1 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      <div className="rounded-2xl border border-border bg-card px-5 py-1">
        <div className="[&>:not([hidden])+:not([hidden])]:border-t [&>:not([hidden])+:not([hidden])]:border-border">
          {children}
        </div>
      </div>
      {footer ? (
        <p className="mt-2 px-1 text-pretty text-[12px] leading-5 text-muted-foreground">
          {footer}
        </p>
      ) : null}
    </section>
  );
}

export function SettingsStack({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-10", className)} {...props} />;
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
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className={cn(
        "text-danger",
        "hover:bg-destructive-subtle active:bg-destructive-subtle/80",
        className,
      )}
      {...props}
    />
  );
}

function labelToString(label: React.ReactNode, fallback: string): string {
  return typeof label === "string" ? label : fallback;
}

/** Shared macOS-style row layout: title + description left, control right. */
function SettingRowShell({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <p className="text-[15px] font-medium leading-6 text-foreground">
          {title}
        </p>
        {description ? (
          <p className="mt-0.5 text-pretty text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}

// ── Switch row ──────────────────────────────────────────────────────────

export interface CloudSwitchRowProps {
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

export function CloudSwitchRow({
  agentId,
  label,
  agentLabel,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  group = "settings",
  agentStatus,
  className,
  testId,
}: CloudSwitchRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
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
    <div className={className}>
      <SettingRowShell
        title={labelToString(label, agentId)}
        description={typeof description === "string" ? description : undefined}
        control={
          <div ref={ref} {...toggleAgentProps} data-testid={testId}>
            <Switch
              id={agentId}
              checked={checked}
              onCheckedChange={onCheckedChange}
              disabled={disabled}
              aria-label={resolvedLabel}
            />
          </div>
        }
      />
    </div>
  );
}

// ── Select row ──────────────────────────────────────────────────────────

export interface CloudSelectRowOption {
  value: string;
  label: string;
}

export interface CloudSelectRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: CloudSelectRowOption[];
  disabled?: boolean;
  group?: string;
  className?: string;
  testId?: string;
}

export function CloudSelectRow({
  agentId,
  label,
  agentLabel,
  description,
  value,
  onValueChange,
  options,
  disabled = false,
  group = "settings",
  className,
  testId,
}: CloudSelectRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
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
    <div className={className}>
      <SettingRowShell
        title={labelToString(label, agentId)}
        description={typeof description === "string" ? description : undefined}
        control={
          <div ref={ref} {...selectAgentProps} data-testid={testId}>
            <FormSelect
              value={value}
              onValueChange={onValueChange}
              disabled={disabled}
              triggerClassName="h-9 w-auto min-w-32 rounded-sm px-3 text-sm"
              aria-label={resolvedLabel}
            >
              {options.map((option) => (
                <FormSelectItem key={option.value} value={option.value}>
                  {option.label}
                </FormSelectItem>
              ))}
            </FormSelect>
          </div>
        }
      />
    </div>
  );
}

// ── Segmented row ───────────────────────────────────────────────────────

export interface CloudSegmentedRowOption {
  value: string;
  label: string;
}

export interface CloudSegmentedRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  options: CloudSegmentedRowOption[];
  group?: string;
  className?: string;
}

export function CloudSegmentedRow({
  agentId,
  label,
  agentLabel,
  description,
  value,
  onValueChange,
  options,
  group = "settings",
}: CloudSegmentedRowProps) {
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
    <SettingRowShell
      title={labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <div ref={ref} {...agentProps}>
          <SegmentedControl
            value={value}
            onValueChange={onValueChange}
            items={options.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            aria-label={resolvedLabel}
          />
        </div>
      }
    />
  );
}

// ── Slider row ──────────────────────────────────────────────────────────

export interface CloudSliderRowProps {
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

export function CloudSliderRow({
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
}: CloudSliderRowProps) {
  const resolvedLabel = agentLabel ?? labelToString(label, agentId);
  const { ref, agentProps } = useAgentElement<HTMLDivElement>({
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
    <SettingRowShell
      title={labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <div ref={ref} {...agentProps} className="flex w-44 items-center gap-3">
          <Slider
            value={[value]}
            onValueChange={(values) => {
              const next = values[0];
              if (typeof next === "number") onValueChange(next);
            }}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-label={resolvedLabel}
          />
          {showValue ? (
            <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
              {value}
              {unit ?? ""}
            </span>
          ) : null}
        </div>
      }
    />
  );
}

// ── Input row ───────────────────────────────────────────────────────────

export interface CloudInputRowProps {
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

export function CloudInputRow({
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
}: CloudInputRowProps) {
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
    <SettingRowShell
      title={labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <input
          ref={ref as React.Ref<HTMLInputElement>}
          id={agentId}
          type={type}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "w-48 rounded-md border border-border bg-bg px-3 py-1.5",
            "text-[14px] leading-5 text-foreground placeholder:text-muted-foreground/60",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "transition-colors",
          )}
          {...(inputAgentProps as Record<string, unknown>)}
        />
      }
    />
  );
}

// ── Action button row ───────────────────────────────────────────────────

export interface CloudActionButtonProps {
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

const ACTION_BUTTON_VARIANT = {
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
  destructive: "destructive",
} as const;

const ACTION_BUTTON_SIZE = {
  sm: "sm",
  md: "default",
  lg: "lg",
} as const;

export function CloudActionButton({
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
}: CloudActionButtonProps) {
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
    <SettingRowShell
      title={labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <Button
          ref={ref}
          variant={ACTION_BUTTON_VARIANT[variant]}
          size={ACTION_BUTTON_SIZE[size]}
          onClick={onActivate}
          disabled={disabled}
          {...(btnAgentProps as Record<string, unknown>)}
        >
          {buttonLabel}
        </Button>
      }
    />
  );
}

// ── Plain row (for custom content / non-standard controls) ──────────────

export interface CloudRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  below?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function CloudRow({
  label,
  description,
  control,
  children,
  below,
  className,
  ...rest
}: CloudRowProps) {
  const effectiveControl = children ?? control ?? null;

  return (
    <div className={cn("py-4", className)} data-testid={rest["data-testid"]}>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-[15px] font-medium leading-6 text-foreground">
            {label}
          </p>
          {description ? (
            <div className="mt-0.5 text-pretty text-[13px] leading-5 text-muted-foreground">
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

// ── Modal / dialog primitives ───────────────────────────────────────────

export interface CloudModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Max width in tailwind class. Default max-w-md. */
  maxWidth?: string;
}

/** A brand-styled composition of the shared modal dialog primitive. */
export function CloudModal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  maxWidth = "max-w-md",
}: CloudModalProps) {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);
  if (
    open &&
    !wasOpenRef.current &&
    document.activeElement instanceof HTMLElement
  ) {
    returnFocusRef.current = document.activeElement;
  }
  wasOpenRef.current = open;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/40"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
          returnFocusRef.current = null;
        }}
        className={cn(
          "block w-[min(calc(100vw_-_2rem),28rem)] gap-0 overflow-y-auto rounded-sm border-border bg-card p-0 sm:p-0 text-foreground shadow-lg",
          maxWidth,
          "max-h-[85vh]",
        )}
      >
        <div className="border-b border-border px-4 py-2.5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle className="text-[15px] font-semibold leading-6 text-foreground">
                {title}
              </DialogTitle>
              {description ? (
                <DialogDescription className="mt-1 text-[13px] leading-5 text-muted-foreground">
                  {description}
                </DialogDescription>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-bg-hover hover:text-foreground"
              aria-label="Close dialog"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="px-4 py-3">{children}</div>
        {footer ? (
          <div className="border-t border-border px-4 py-2.5">{footer}</div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface CloudConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * A simple confirmation dialog for destructive actions (disconnect, remove).
 */
export function CloudConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onClose,
}: CloudConfirmDialogProps) {
  return (
    <CloudModal
      open={open}
      title={title}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <p className="text-[14px] leading-5 text-muted-foreground">
        {description}
      </p>
    </CloudModal>
  );
}

/** A labeled form field wrapper for use inside modals. */
export function CloudFormField({
  label,
  description,
  children,
  htmlFor,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[13px] font-medium leading-5 text-foreground"
      >
        {label}
      </label>
      {description ? (
        <p className="text-[12px] leading-4 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** A text input styled to match the settings panel. */
export function CloudTextInput({
  id,
  type = "text",
  value,
  onChange,
  placeholder,
  disabled,
  autoComplete,
}: {
  id?: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoComplete?: string;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      autoComplete={autoComplete}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-md border border-border bg-bg px-3 py-2",
        "text-[14px] leading-5 text-foreground placeholder:text-muted-foreground/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
      )}
    />
  );
}
