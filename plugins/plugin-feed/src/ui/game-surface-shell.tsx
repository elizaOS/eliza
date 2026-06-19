import type { CSSProperties, ReactNode } from "react";

// Shared visual shell for game/app operator surfaces: a compact header (title +
// status + CTA), a horizontal status strip of stat chips, and a content zone.
// Inline styles only — the view bundle does not ship Tailwind, so utility
// classes do not paint here. Theme tokens (--accent, --card, --border …) are
// read via CSS var().

export type ChipState = "ready" | "pending" | "active" | "idle" | "danger";

export interface StatChip {
  icon: string;
  label: string;
  value: string;
  state?: ChipState;
}

const STATE_COLOR: Record<ChipState, string> = {
  ready: "var(--ok, #22c55e)",
  active: "var(--accent, #ff8a24)",
  pending: "var(--warn, #f59e0b)",
  idle: "var(--muted, #9ca3af)",
  danger: "var(--danger, #ef4444)",
};

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  minHeight: "100%",
  background: "var(--bg, transparent)",
  color: "var(--foreground, #111)",
};

export function GameSurfaceShell({ children }: { children: ReactNode }) {
  return <div style={rootStyle}>{children}</div>;
}

export function GameSurfaceHero({
  title,
  statusLabel,
  statusState = "pending",
  cta,
}: {
  title: string;
  statusLabel: string;
  statusState?: ChipState;
  cta?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "14px 16px",
        borderBottom: "1px solid var(--border, rgba(0,0,0,0.1))",
        background: "var(--card, rgba(0,0,0,0.02))",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--foreground, #111)",
            lineHeight: 1.2,
          }}
        >
          {title}
        </div>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            marginTop: 6,
            fontSize: 12,
            color: "var(--muted, #6b7280)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: STATE_COLOR[statusState],
            }}
          />
          <span>{statusLabel}</span>
        </div>
      </div>
      {cta ? <div style={{ flexShrink: 0 }}>{cta}</div> : null}
    </div>
  );
}

export function HeroCta({
  label,
  onClick,
  disabled,
  accent = "var(--accent, #ff8a24)",
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  accent?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "9px 16px",
        borderRadius: 12,
        border: "none",
        background: accent,
        color: "#fff",
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: "0.01em",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        boxShadow: "0 4px 16px rgba(0,0,0,0.28)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

export function GameSurfaceStrip({ chips }: { chips: StatChip[] }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        padding: "12px 16px",
        overflowX: "auto",
        borderBottom: "1px solid var(--border, rgba(0,0,0,0.08))",
        background: "var(--card, rgba(255,255,255,0.5))",
      }}
    >
      {chips.map((chip) => (
        <div
          key={chip.label}
          style={{
            flex: "1 1 0",
            minWidth: 120,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 14,
            border: "1px solid var(--border, rgba(0,0,0,0.08))",
            background: "var(--bg, rgba(255,255,255,0.6))",
          }}
        >
          <div
            style={{
              display: "grid",
              placeItems: "center",
              width: 34,
              height: 34,
              borderRadius: 10,
              fontSize: 17,
              flexShrink: 0,
              background: `${STATE_COLOR[chip.state ?? "idle"]}1f`,
              color: STATE_COLOR[chip.state ?? "idle"],
            }}
          >
            {chip.icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--muted, #6b7280)",
              }}
            >
              {chip.label}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--foreground, #111)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  flexShrink: 0,
                  background: STATE_COLOR[chip.state ?? "idle"],
                }}
              />
              {chip.value}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function GameSurfaceZone({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {children}
    </div>
  );
}

export function WaitingForSession({
  accent = "var(--accent, #ff8a24)",
  message,
}: {
  accent?: string;
  message: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 220,
        display: "grid",
        placeItems: "center",
        padding: "24px 16px",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: 360 }}>
        <div
          style={{
            margin: "0 auto 16px",
            width: 56,
            height: 56,
            borderRadius: 18,
            display: "grid",
            placeItems: "center",
            background: `${accent}14`,
            border: `1px solid ${accent}3a`,
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 999,
              background: accent,
              animation: "gsPulse 1.6s ease-in-out infinite",
            }}
          />
        </div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--muted, #6b7280)",
            lineHeight: 1.5,
          }}
        >
          {message}
        </div>
      </div>
      <style>{`@keyframes gsPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.72)}}`}</style>
    </div>
  );
}
