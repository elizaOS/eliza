/**
 * elizaOS-owned settings primitives for the cloud-only desktop panel.
 *
 * These compositions preserve the cloud panel's compact native spacing and
 * typography while using the canonical component layer, elizaOS tokens, and
 * agent-surface instrumentation. Feature sections own behavior; this module
 * owns only consistent row geometry and control presentation.
 */
import type { LucideIcon } from "lucide-react";
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
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Slider } from "../../ui/slider";
import { Switch } from "../../ui/switch";

type CloudSettingsButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "size" | "variant"
> & {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
};

/** Canonical elizaOS button with the cloud panel's compact size vocabulary. */
export const CloudSettingsButton = React.forwardRef<
  HTMLButtonElement,
  CloudSettingsButtonProps
>(({ variant = "primary", size = "md", className, ...props }, ref) => (
  <Button
    ref={ref}
    variant={variant === "primary" ? "default" : variant}
    size={size === "md" ? "default" : size}
    className={cn("rounded-lg", className)}
    {...props}
  />
));
CloudSettingsButton.displayName = "CloudSettingsButton";

function SettingsRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-6 py-4">
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
      <div className="rounded-2xl border border-hairline bg-surface px-5 py-1">
        <div className="cloud-settings-group-rows">{children}</div>
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
}: React.ComponentProps<typeof CloudSettingsButton>) {
  return (
    <CloudSettingsButton
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

export interface CloudSettingsSwitchRowProps {
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

export function CloudSettingsSwitchRow({
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
}: CloudSettingsSwitchRowProps) {
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
      <SettingsRow
        title={
          typeof label === "string" ? label : labelToString(label, agentId)
        }
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

export interface CloudSettingsSelectRowOption {
  value: string;
  label: string;
}

export interface CloudSettingsSelectRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: CloudSettingsSelectRowOption[];
  disabled?: boolean;
  group?: string;
  className?: string;
  testId?: string;
}

export function CloudSettingsSelectRow({
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
}: CloudSettingsSelectRowProps) {
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
      <SettingsRow
        title={
          typeof label === "string" ? label : labelToString(label, agentId)
        }
        description={typeof description === "string" ? description : undefined}
        control={
          <div ref={ref} {...selectAgentProps} data-testid={testId}>
            <Select
              value={value}
              onValueChange={onValueChange}
              disabled={disabled}
            >
              <SelectTrigger
                className="h-9 min-w-36 rounded-lg"
                aria-label={resolvedLabel}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
    </div>
  );
}

// ── Segmented row ───────────────────────────────────────────────────────

export interface CloudSettingsSegmentedRowOption {
  value: string;
  label: string;
}

export interface CloudSettingsSegmentedRowProps {
  agentId: string;
  label: React.ReactNode;
  agentLabel?: string;
  description?: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  options: CloudSettingsSegmentedRowOption[];
  group?: string;
  className?: string;
}

export function CloudSettingsSegmentedRow({
  agentId,
  label,
  agentLabel,
  description,
  value,
  onValueChange,
  options,
  group = "settings",
}: CloudSettingsSegmentedRowProps) {
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
    <SettingsRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <div ref={ref} {...agentProps}>
          <div
            role="tablist"
            aria-label={resolvedLabel}
            className="inline-flex rounded-xl bg-fill p-1"
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={option.value === value}
                onClick={() => onValueChange(option.value)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[14px] font-medium transition-colors",
                  option.value === value
                    ? "bg-surface text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      }
    />
  );
}

// ── Slider row ──────────────────────────────────────────────────────────

export interface CloudSettingsSliderRowProps {
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

export function CloudSettingsSliderRow({
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
}: CloudSettingsSliderRowProps) {
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
    <SettingsRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <div className="flex min-w-48 items-center gap-3">
          <Slider
            value={[value]}
            onValueChange={([next]) => {
              if (next !== undefined) onValueChange(next);
            }}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-label={resolvedLabel}
            {...agentProps}
          />
          {showValue ? (
            <output className="min-w-12 text-end text-[13px] tabular-nums text-muted-foreground">
              {value}
              {unit ?? ""}
            </output>
          ) : null}
        </div>
      }
    />
  );
}

// ── Input row ───────────────────────────────────────────────────────────

export interface CloudSettingsInputRowProps {
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

export function CloudSettingsInputRow({
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
}: CloudSettingsInputRowProps) {
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
    <SettingsRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <Input
          ref={ref as React.Ref<HTMLInputElement>}
          id={agentId}
          type={type}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={resolvedLabel}
          {...(inputAgentProps as Record<string, unknown>)}
        />
      }
    />
  );
}

// ── Action button row ───────────────────────────────────────────────────

export interface CloudSettingsActionButtonProps {
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

export function CloudSettingsActionButton({
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
}: CloudSettingsActionButtonProps) {
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
    <SettingsRow
      title={typeof label === "string" ? label : labelToString(label, agentId)}
      description={typeof description === "string" ? description : undefined}
      control={
        <CloudSettingsButton
          ref={ref}
          variant={variant}
          size={size}
          onClick={onActivate}
          disabled={disabled}
          {...(btnAgentProps as Record<string, unknown>)}
        >
          {buttonLabel}
        </CloudSettingsButton>
      }
    />
  );
}

// ── Plain row (for custom content / non-standard controls) ──────────────

export interface CloudSettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  below?: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function CloudSettingsRow({
  label,
  description,
  control,
  children,
  below,
  className,
  ...rest
}: CloudSettingsRowProps) {
  const effectiveControl = children ?? control ?? null;
  const labelIsString = typeof label === "string";
  const descIsString = typeof description === "string";

  // Fast path: plain string label/description → delegate to elizaOS SettingRow.
  if (labelIsString && descIsString && !below && !className) {
    return (
      <SettingsRow
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

// ── Modal / dialog primitives ───────────────────────────────────────────

export interface CloudSettingsModalProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Max width in tailwind class. Default max-w-md. */
  maxWidth?: string;
}

/** A elizaOS-styled composition of the shared modal dialog primitive. */
export function CloudSettingsModal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  maxWidth = "max-w-md",
}: CloudSettingsModalProps) {
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
        overlayClassName="bg-black/40 backdrop-blur-[2px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
          returnFocusRef.current = null;
        }}
        className={cn(
          "block w-[min(calc(100vw_-_2rem),28rem)] gap-0 overflow-y-auto rounded-xl border-hairline bg-surface p-0 text-foreground shadow-lg",
          maxWidth,
          "max-h-[85vh]",
        )}
      >
        <div className="border-b border-hairline px-5 py-4">
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
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-fill hover:text-foreground"
              aria-label="Close dialog"
            >
              <svg
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer ? (
          <div className="border-t border-hairline px-5 py-3">{footer}</div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export interface CloudSettingsConfirmDialogProps {
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
export function CloudSettingsConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onClose,
}: CloudSettingsConfirmDialogProps) {
  return (
    <CloudSettingsModal
      open={open}
      title={title}
      onClose={onClose}
      maxWidth="max-w-sm"
      footer={
        <div className="flex justify-end gap-2">
          <CloudSettingsButton variant="ghost" size="sm" onClick={onClose}>
            {cancelLabel}
          </CloudSettingsButton>
          <CloudSettingsButton
            variant={destructive ? "destructive" : "primary"}
            size="sm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </CloudSettingsButton>
        </div>
      }
    >
      <p className="text-[14px] leading-5 text-muted-foreground">
        {description}
      </p>
    </CloudSettingsModal>
  );
}

/** A labeled form field wrapper for use inside modals. */
export function CloudSettingsFormField({
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

/** A text input styled to match the elizaOS settings panel. */
export function CloudSettingsTextInput({
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
        "w-full rounded-md border border-hairline bg-surface px-3 py-2",
        "text-[14px] leading-5 text-foreground placeholder:text-muted-foreground/60",
        "focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
      )}
    />
  );
}
