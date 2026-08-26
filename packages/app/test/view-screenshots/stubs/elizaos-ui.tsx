/**
 * Stub for `@elizaos/ui` — the giant renderer barrel — used by the view
 * screenshot harness. Aliased in place of the real package via vite
 * `resolve.alias`. Mirrors exactly the surface the views' own jsdom tests mock:
 *
 * - `client.getBaseUrl()` / `client.sendChatMessage()` — touched only by the
 *   views' default fetcher seams, which the harness always overrides; provided
 *   so the module-level affordances (Connect / Add / Set-goal buttons) don't
 *   throw on render.
 * - `useApp()` / `useMediaQuery()` — used by CalendarView + CalendarSection.
 * - `Button` / `Spinner` / `Popover*` / `SegmentedControl` — Calendar UI
 *   primitives, stubbed to plain DOM exactly like CalendarSection.test.tsx.
 */

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { forwardRef } from "react";

export class ElizaClient {
  fetch = async (): Promise<Record<string, never>> => ({});
}

export const client = {
  getBaseUrl: () => "http://test.local",
  sendChatMessage: (..._args: unknown[]) => {},
  // Real hook calls this when useCalendarWeek is NOT stubbed; the harness
  // always stubs useCalendarWeek, so this is a never-resolving guard.
  getLifeOpsCalendarFeed: (..._args: unknown[]) => new Promise<never>(() => {}),
  getLifeOpsIcsCalendarSources: async () => ({ sources: [] }),
  createLifeOpsIcsCalendarSource: async (..._args: unknown[]) => ({
    source: null,
  }),
  updateLifeOpsIcsCalendarSource: async (..._args: unknown[]) => ({
    source: null,
  }),
  deleteLifeOpsIcsCalendarSource: async (..._args: unknown[]) => ({
    deleted: true as const,
  }),
  syncLifeOpsIcsCalendarSource: async (..._args: unknown[]) => ({
    source: null,
    outcome: "complete" as const,
    acceptedEvents: 0,
    prunedEvents: 0,
    tombstones: 0,
  }),
  stopWebsiteBlock: async () => ({ success: true, removed: true }),
};

export function useApp(): {
  t: (key: string, opts?: { defaultValue?: string }) => string;
  setActionNotice: (...args: unknown[]) => void;
} {
  return {
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    setActionNotice: () => {},
  };
}

// Desktop default; the calendar fixtures flip this through `?compact=1`.
export function useMediaQuery(): boolean {
  return globalThis.__VIEW_HARNESS_COMPACT__ === true;
}

/** Accessible visual stand-in for the canonical shared view header. */
export function ViewHeader({
  title,
  onBack,
  backLabel = "Back to launcher",
  showBack = true,
  right,
}: {
  title: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  showBack?: boolean;
  right?: ReactNode;
}): ReactNode {
  return (
    <header
      data-testid="view-header"
      style={{
        position: "relative",
        display: "flex",
        minHeight: 56,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 12px",
      }}
    >
      {showBack ? (
        <button
          type="button"
          aria-label={backLabel}
          onClick={onBack}
          style={{
            position: "relative",
            zIndex: 1,
            width: 44,
            height: 44,
            border: 0,
            background: "transparent",
            color: "inherit",
            fontSize: 22,
            cursor: "pointer",
          }}
        >
          ←
        </button>
      ) : (
        <span aria-hidden />
      )}
      <h1
        style={{
          position: "absolute",
          insetInline: 48,
          margin: 0,
          overflow: "hidden",
          textAlign: "center",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 18,
          fontWeight: 600,
        }}
      >
        {title}
      </h1>
      <span style={{ position: "relative", zIndex: 1 }}>{right}</span>
    </header>
  );
}

interface HarnessButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: string;
  size?: string;
  shape?: string;
  align?: string;
  asChild?: boolean;
  unstyled?: boolean;
  "data-state"?: string;
}

export function Button({
  align: _align,
  asChild: _asChild,
  children,
  shape,
  size,
  style,
  unstyled: _unstyled,
  variant,
  ...props
}: HarnessButtonProps): ReactNode {
  const sizeStyle: CSSProperties =
    size === "icon-lg"
      ? { width: 44, height: 44, padding: 0 }
      : size === "tile"
        ? {
            minHeight: 48,
            padding: 8,
            flexDirection: "column",
            gap: 4,
          }
        : size === "touch"
          ? { minHeight: 44, padding: "8px 16px" }
          : {};
  const selected = props["data-state"] === "on";
  const variantStyle: CSSProperties =
    variant === "selection"
      ? {
          background: selected ? "rgba(255, 106, 0, 0.2)" : "transparent",
          color: "var(--txt)",
        }
      : variant === "surface"
        ? { background: "var(--card)", color: "var(--txt)" }
        : variant === "default"
          ? { background: "var(--accent)", color: "#111" }
          : variant === "sectionToggle"
            ? {
                width: "100%",
                minHeight: 44,
                justifyContent: "flex-start",
                gap: 8,
                padding: "8px 12px",
                textAlign: "left",
                background: "transparent",
                color: "var(--txt)",
              }
            : { background: "transparent", color: "var(--txt)" };
  return (
    <button
      type="button"
      {...props}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        border: 0,
        borderRadius: shape === "circle" ? 9999 : 6,
        font: "inherit",
        cursor: "pointer",
        ...sizeStyle,
        ...variantStyle,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

interface HarnessInputProps extends InputHTMLAttributes<HTMLInputElement> {
  density?: string;
  variant?: string;
  adornment?: string;
  hasError?: boolean;
}

export const Input = forwardRef<HTMLInputElement, HarnessInputProps>(
  (
    {
      adornment: _adornment,
      density: _density,
      hasError,
      style,
      variant: _variant,
      ...props
    },
    ref,
  ) => (
    <input
      ref={ref}
      {...props}
      style={{
        boxSizing: "border-box",
        minHeight: 40,
        minWidth: 0,
        border: `1px solid ${hasError ? "var(--danger, #ef4444)" : "var(--border)"}`,
        borderRadius: 6,
        background: "var(--bg)",
        color: "var(--txt)",
        padding: "8px 10px",
        font: "inherit",
        ...style,
      }}
    />
  ),
);
Input.displayName = "HarnessInput";

interface HarnessSwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = forwardRef<HTMLButtonElement, HarnessSwitchProps>(
  (
    {
      checked = false,
      children,
      disabled,
      onCheckedChange,
      onClick,
      style,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked ? "true" : "false"}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) onCheckedChange?.(!checked);
      }}
      {...props}
      style={{
        boxSizing: "border-box",
        display: "inline-flex",
        width: 44,
        minWidth: 44,
        height: 24,
        minHeight: 24,
        alignItems: "center",
        justifyContent: checked ? "flex-end" : "flex-start",
        border: 0,
        borderRadius: 9999,
        padding: 2,
        background: checked ? "var(--accent)" : "var(--bg-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          display: "block",
          width: 20,
          height: 20,
          borderRadius: 9999,
          background: checked ? "var(--card)" : "var(--txt)",
        }}
      />
      {children}
    </button>
  ),
);
Switch.displayName = "HarnessSwitch";

export function ConfirmDialog({
  open,
  title = "Confirm",
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      <p>{message}</p>
      <Button variant="outline" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button variant="destructive" onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  );
}

export function Grid({
  children,
  columns: _columns,
  spacing: _spacing,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  columns?: number;
  spacing?: string;
}): ReactNode {
  return (
    <div {...props} style={{ display: "grid", ...style }}>
      {children}
    </div>
  );
}

export function Select({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>;
}

export function SelectTrigger({
  children,
  variant: _variant,
  ...props
}: HarnessButtonProps): ReactNode {
  return (
    <button type="button" {...props}>
      {children}
    </button>
  );
}

export function SelectValue(): ReactNode {
  return <span>2026</span>;
}

export function SelectContent({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <div>{children}</div>;
}

export function SelectItem({
  children,
  value,
}: {
  children: ReactNode;
  value: string;
}): ReactNode {
  return <span data-value={value}>{children}</span>;
}

export function Spinner(): ReactNode {
  return <span data-testid="spinner">⟳</span>;
}

export function Popover({ children }: { children: ReactNode }): ReactNode {
  return <div>{children}</div>;
}

export function PopoverTrigger({
  children,
}: {
  children: ReactNode;
  asChild?: boolean;
}): ReactNode {
  return children;
}

export function PopoverContent({
  children: _children,
  ..._props
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): ReactNode {
  // Screenshot states keep the picker closed; omit its portal content just as
  // Radix does until the trigger is activated.
  return null;
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  items,
}: {
  value: T;
  onValueChange: (value: T) => void;
  items: Array<{ value: T; label: ReactNode }>;
}): ReactNode {
  return (
    <div data-segmented-control>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          data-testid={`view-${item.value}`}
          onClick={() => onValueChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __VIEW_HARNESS_COMPACT__: boolean | undefined;
}
