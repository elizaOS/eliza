/**
 * Small, bundle-local controls for the Notes surface. Inline material styles keep dynamic view bundles self-contained,
 * while the agent-surface registrations give every editable field and action a
 * stable semantic target for chat-driven interaction.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import type { StickyColor } from "../types.js";

export function handleRenderedMutationFailure(cause: unknown): void {
  if (!(cause instanceof Error)) throw cause;
}

export const VIEW_ROOT_STYLE: CSSProperties = {
  boxSizing: "border-box",
  position: "relative",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "hidden",
  color: "var(--txt, #f5f5f5)",
  fontFamily: "inherit",
};

export const VIEW_SCROLL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  position: "absolute",
  insetBlockStart: 0,
  insetBlockEnd: 0,
  insetInlineStart: 0,
  insetInlineEnd: 0,
  minWidth: 0,
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "clamp(8px, 2.4vw, 24px)",
  paddingTop: "calc(clamp(8px, 2.4vw, 24px) + var(--safe-area-top, 0px))",
  // The scroll surface reaches the routed viewport edge so translucent chat
  // chrome reveals real view content. Padding keeps the final item reachable
  // above the composer and landscape side rail without clipping the surface.
  paddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-clearance, 5.25rem))",
  paddingInlineEnd:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-side-clearance, 0px))",
  scrollPaddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-clearance, 5.25rem))",
  scrollPaddingInlineEnd:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-side-clearance, 0px))",
  color: "var(--txt, #f5f5f5)",
  fontFamily: "inherit",
};

export const GLASS_PANEL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  border: "none",
  borderRadius: 22,
  background:
    "color-mix(in srgb, var(--card, rgba(16,16,16,.88)) 76%, transparent)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,.10), 0 18px 48px rgba(0,0,0,.20)",
  backdropFilter: "blur(24px) saturate(145%)",
  WebkitBackdropFilter: "blur(24px) saturate(145%)",
};

export const FIELD_STYLE: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  minHeight: 44,
  border: "none",
  borderRadius: 13,
  padding: "10px 12px",
  background: "color-mix(in srgb, var(--bg, #080808) 78%, transparent)",
  color: "var(--txt, #f5f5f5)",
  font: "inherit",
  fontSize: 14,
  lineHeight: 1.45,
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,.10)",
};

export const LABEL_STYLE: CSSProperties = {
  display: "grid",
  gap: 7,
  color: "var(--muted-strong, rgba(255,255,255,.76))",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: ".02em",
};

export const SECONDARY_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--muted, rgba(255,255,255,.58))",
  fontSize: 13,
  lineHeight: 1.45,
};

const BUTTON_STYLE: CSSProperties = {
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 44,
  border: "none",
  borderRadius: 12,
  padding: "8px 12px",
  background:
    "color-mix(in srgb, var(--surface, rgba(255,255,255,.08)) 86%, transparent)",
  color: "var(--txt, #f5f5f5)",
  font: "inherit",
  fontSize: 13,
  fontWeight: 650,
  cursor: "pointer",
  transition: "background 160ms ease, opacity 160ms ease, transform 160ms ease",
};

export function AgentAction({
  agentId,
  agentLabel,
  agentGroup,
  agentStatus,
  onClick,
  variant = "secondary",
  compact = false,
  style,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  agentId: string;
  agentLabel: string;
  agentGroup: string;
  agentStatus?: string;
  variant?: "primary" | "secondary" | "quiet";
  compact?: boolean;
}) {
  const control = useAgentElement<HTMLButtonElement>({
    id: agentId,
    label: agentLabel,
    role: "button",
    group: agentGroup,
    status: agentStatus,
    onActivate: () => {
      if (!disabled) onClick?.({} as never);
    },
  });
  const variantStyle: CSSProperties =
    variant === "primary"
      ? {
          background: disabled
            ? "color-mix(in srgb, var(--surface, rgba(255,255,255,.08)) 86%, transparent)"
            : "var(--accent, #ff6a1f)",
          color: "var(--accent-foreground, #fff)",
        }
      : variant === "quiet"
        ? { background: "transparent" }
        : {};
  return (
    <button
      ref={control.ref}
      type="button"
      {...control.agentProps}
      {...rest}
      aria-label={rest["aria-label"] ?? (compact ? agentLabel : undefined)}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...BUTTON_STYLE,
        ...variantStyle,
        ...(compact ? { minWidth: 44, width: 44, padding: 0 } : {}),
        ...(disabled ? { cursor: "default", opacity: 0.5 } : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function AgentInput({
  agentId,
  agentLabel,
  agentGroup,
  value,
  onValue,
  style,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  agentId: string;
  agentLabel: string;
  agentGroup: string;
  value: string;
  onValue: (value: string) => void;
}) {
  const control = useAgentElement<HTMLInputElement>({
    id: agentId,
    label: agentLabel,
    role: "text-input",
    group: agentGroup,
    fillable: true,
    getValue: () => value,
    onFill: onValue,
  });
  return (
    <input
      ref={control.ref}
      id={agentId}
      aria-label={agentLabel}
      {...control.agentProps}
      {...rest}
      value={value}
      onChange={(event) => onValue(event.target.value)}
      style={{ ...FIELD_STYLE, ...style }}
    />
  );
}

export function AgentTextarea({
  agentId,
  agentLabel,
  agentGroup,
  value,
  onValue,
  style,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  agentId: string;
  agentLabel: string;
  agentGroup: string;
  value: string;
  onValue: (value: string) => void;
}) {
  const control = useAgentElement<HTMLTextAreaElement>({
    id: agentId,
    label: agentLabel,
    role: "textarea",
    group: agentGroup,
    fillable: true,
    getValue: () => value,
    onFill: onValue,
  });
  return (
    <textarea
      ref={control.ref}
      id={agentId}
      aria-label={agentLabel}
      {...control.agentProps}
      {...rest}
      value={value}
      onChange={(event) => onValue(event.target.value)}
      style={{ ...FIELD_STYLE, minHeight: 104, resize: "vertical", ...style }}
    />
  );
}

export const COLOR_MATERIALS: Record<
  StickyColor,
  { fill: string; dot: string }
> = {
  yellow: {
    fill: "rgba(234, 179, 8, .13)",
    dot: "#eab308",
  },
  green: {
    fill: "rgba(34, 197, 94, .11)",
    dot: "#4ade80",
  },
  rose: {
    fill: "rgba(244, 63, 94, .10)",
    dot: "#fb7185",
  },
  slate: {
    fill: "rgba(148, 148, 148, .11)",
    dot: "#b9b9b9",
  },
};

export function ColorPicker({
  value,
  onChange,
  group,
}: {
  value: StickyColor;
  onChange: (color: StickyColor) => void;
  group: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      {(Object.keys(COLOR_MATERIALS) as StickyColor[]).map((color) => (
        <AgentAction
          key={color}
          agentId={`${group}-color-${color}`}
          agentLabel={`Use ${color} color`}
          agentGroup={group}
          agentStatus={value === color ? "selected" : "idle"}
          compact
          variant="quiet"
          onClick={() => onChange(color)}
          title={`${color[0]?.toUpperCase()}${color.slice(1)}`}
          style={{
            minWidth: 44,
            width: 44,
            minHeight: 44,
            height: 44,
            borderRadius: 999,
            background: COLOR_MATERIALS[color].fill,
            boxShadow:
              value === color
                ? "inset 0 0 0 2px var(--txt, #fff), 0 0 0 2px rgba(255,255,255,.12)"
                : "inset 0 0 0 1px rgba(255,255,255,.10)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: COLOR_MATERIALS[color].dot,
            }}
          />
        </AgentAction>
      ))}
    </div>
  );
}

export function ViewHeader({
  icon,
  title,
  detail,
  actions,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  actions?: ReactNode;
}) {
  return (
    <header
      style={{
        ...GLASS_PANEL_STYLE,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
        marginBottom: 14,
        padding: "12px 14px",
        borderRadius: 18,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 11, minWidth: 0 }}
      >
        <span
          aria-hidden
          style={{
            display: "grid",
            placeItems: "center",
            width: 38,
            height: 38,
            flex: "0 0 auto",
            borderRadius: 12,
            background: "var(--surface, rgba(255,255,255,.08))",
          }}
        >
          {icon}
        </span>
        <div style={{ minWidth: 0 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 19,
              lineHeight: 1.2,
              fontWeight: 720,
            }}
          >
            {title}
          </h1>
          <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 3 }}>{detail}</p>
        </div>
      </div>
      {actions ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
          }}
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function ViewState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyBody,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyBody: string;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <div
        role="status"
        style={{ ...GLASS_PANEL_STYLE, padding: 24, textAlign: "center" }}
      >
        <p style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>Loading…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        style={{ ...GLASS_PANEL_STYLE, padding: 20, textAlign: "center" }}
      >
        <p style={{ margin: 0, fontSize: 14, fontWeight: 680 }}>
          Couldn’t load this view
        </p>
        <p
          style={{
            ...SECONDARY_TEXT_STYLE,
            margin: "6px auto 14px",
            maxWidth: 440,
          }}
        >
          {error}
        </p>
        {onRetry ? (
          <AgentAction
            agentId="notes-retry"
            agentLabel="Retry Notes"
            agentGroup="notes-status"
            onClick={onRetry}
          >
            Retry
          </AgentAction>
        ) : null}
      </div>
    );
  }
  if (!empty) return null;
  return (
    <div style={{ ...GLASS_PANEL_STYLE, padding: 24, textAlign: "center" }}>
      <p style={{ margin: 0, fontSize: 14, fontWeight: 680 }}>{emptyTitle}</p>
      <p
        style={{ ...SECONDARY_TEXT_STYLE, margin: "6px auto 0", maxWidth: 400 }}
      >
        {emptyBody}
      </p>
    </div>
  );
}
