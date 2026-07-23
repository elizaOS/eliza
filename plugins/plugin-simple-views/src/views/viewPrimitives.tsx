/**
 * Small, bundle-local controls for the Notes and Simple Calendar developer
 * surfaces. Inline material styles keep dynamic view bundles self-contained,
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
import { STICKY_COLORS, type StickyColor } from "../types.js";

export function rethrowUnexpectedMutationFailure(cause: unknown): void {
  if (!(cause instanceof Error)) throw cause;
}

export const VIEW_ROOT_STYLE: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "clamp(8px, 2.4vw, 24px)",
  paddingTop: "calc(clamp(8px, 2.4vw, 24px) + var(--safe-area-top, 0px))",
  paddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-continuous-chat-clearance, 5.25rem))",
  paddingInlineEnd:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-continuous-chat-side-clearance, 0px))",
  scrollPaddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-continuous-chat-clearance, 5.25rem))",
  scrollPaddingInlineEnd:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-continuous-chat-side-clearance, 0px))",
  color: "var(--txt, #f5f5f5)",
  fontFamily: "inherit",
};

export const GLASS_PANEL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  border:
    "1px solid color-mix(in srgb, var(--border-strong, rgba(255,255,255,.24)) 78%, transparent)",
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
  border: "1px solid var(--border-strong, rgba(255,255,255,.22))",
  borderRadius: 13,
  padding: "10px 12px",
  background: "color-mix(in srgb, var(--bg, #080808) 78%, transparent)",
  color: "var(--txt, #f5f5f5)",
  font: "inherit",
  fontSize: 14,
  lineHeight: 1.45,
  outline: "none",
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
  border: "1px solid var(--border-strong, rgba(255,255,255,.22))",
  borderRadius: 12,
  padding: "8px 12px",
  background:
    "color-mix(in srgb, var(--surface, rgba(255,255,255,.08)) 86%, transparent)",
  color: "var(--txt, #f5f5f5)",
  font: "inherit",
  fontSize: 13,
  fontWeight: 650,
  cursor: "pointer",
  transition:
    "background 160ms ease, border-color 160ms ease, opacity 160ms ease, transform 160ms ease",
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
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  agentId: string;
  agentLabel: string;
  agentGroup: string;
  agentStatus?: string;
  variant?: "primary" | "secondary" | "quiet";
  compact?: boolean;
  onClick?: () => void;
}) {
  const control = useAgentElement<HTMLButtonElement>({
    id: agentId,
    label: agentLabel,
    role: "button",
    group: agentGroup,
    status: agentStatus,
    onActivate: () => {
      if (!disabled) onClick?.();
    },
  });
  const variantStyle: CSSProperties =
    variant === "primary"
      ? {
          borderColor: "var(--accent, #ff6a1f)",
          background: "var(--accent, #ff6a1f)",
          color: "var(--accent-foreground, #fff)",
        }
      : variant === "quiet"
        ? { borderColor: "transparent", background: "transparent" }
        : {};
  return (
    <button
      ref={control.ref}
      type="button"
      {...control.agentProps}
      {...rest}
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
  { fill: string; border: string; dot: string }
> = {
  yellow: {
    fill: "rgba(234, 179, 8, .13)",
    border: "rgba(250, 204, 21, .42)",
    dot: "#eab308",
  },
  green: {
    fill: "rgba(34, 197, 94, .11)",
    border: "rgba(74, 222, 128, .36)",
    dot: "#4ade80",
  },
  rose: {
    fill: "rgba(244, 63, 94, .10)",
    border: "rgba(251, 113, 133, .36)",
    dot: "#fb7185",
  },
  slate: {
    fill: "rgba(148, 148, 148, .11)",
    border: "rgba(186, 186, 186, .34)",
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
      {STICKY_COLORS.map((color) => (
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
            borderColor:
              value === color
                ? "var(--txt, #fff)"
                : COLOR_MATERIALS[color].border,
            background: COLOR_MATERIALS[color].fill,
            boxShadow:
              value === color ? "0 0 0 2px rgba(255,255,255,.12)" : "none",
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
            border: "1px solid var(--border-strong, rgba(255,255,255,.2))",
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

export function ViewState(
  props:
    | { status: "loading" }
    | { status: "error"; message: string; onRetry: () => void }
    | { status: "empty"; title: string; body: string },
) {
  if (props.status === "loading") {
    return (
      <div
        role="status"
        style={{ ...GLASS_PANEL_STYLE, padding: 24, textAlign: "center" }}
      >
        <p style={{ margin: 0, fontSize: 14, fontWeight: 650 }}>Loading…</p>
      </div>
    );
  }
  if (props.status === "error") {
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
          {props.message}
        </p>
        <AgentAction
          agentId="simple-views-retry"
          agentLabel="Retry Simple Views"
          agentGroup="simple-views-status"
          onClick={props.onRetry}
        >
          Retry
        </AgentAction>
      </div>
    );
  }
  return (
    <div style={{ ...GLASS_PANEL_STYLE, padding: 24, textAlign: "center" }}>
      <p style={{ margin: 0, fontSize: 14, fontWeight: 680 }}>{props.title}</p>
      <p
        style={{ ...SECONDARY_TEXT_STYLE, margin: "6px auto 0", maxWidth: 400 }}
      >
        {props.body}
      </p>
    </div>
  );
}
