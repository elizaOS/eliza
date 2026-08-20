/**
 * Bundle-local styles and phase components for the /maps surface. Inline
 * material styles keep the dynamic view bundle self-contained; loading,
 * designed-empty, and error render as three visibly different states.
 */

import type { CSSProperties, ReactNode } from "react";

export const ACCENT = "var(--accent, #ff6a1f)";

export const VIEW_ROOT_STYLE: CSSProperties = {
  boxSizing: "border-box",
  position: "relative",
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflow: "hidden",
  color: "var(--txt, #f5f5f5)",
  fontFamily: "inherit",
};

export const VIEW_SCROLL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  position: "absolute",
  inset: 0,
  minWidth: 0,
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "clamp(8px, 2.4vw, 24px)",
  paddingTop: "calc(clamp(8px, 2.4vw, 24px) + var(--safe-area-top, 0px))",
  paddingBottom:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-clearance, 5.25rem))",
  paddingInlineEnd:
    "calc(clamp(8px, 2.4vw, 24px) + var(--eliza-chat-side-clearance, 0px))",
  color: "var(--txt, #f5f5f5)",
  fontFamily: "inherit",
};

export const GLASS_PANEL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  border: "none",
  borderRadius: 20,
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
  borderRadius: 12,
  padding: "10px 12px",
  background: "color-mix(in srgb, var(--bg, #080808) 78%, transparent)",
  color: "var(--txt, #f5f5f5)",
  font: "inherit",
  fontSize: 14,
  lineHeight: 1.45,
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,.10)",
};

export const SECONDARY_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--muted, rgba(255,255,255,.58))",
  fontSize: 13,
  lineHeight: 1.45,
};

export const BUTTON_STYLE: CSSProperties = {
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 40,
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
};

export const PRIMARY_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  background: ACCENT,
  color: "var(--accent-foreground, #fff)",
};

export const ERROR_PANEL_STYLE: CSSProperties = {
  ...GLASS_PANEL_STYLE,
  padding: 14,
  color: "var(--status-danger, #ff857a)",
};

export function ViewState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyBody,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyBody: string;
}): ReactNode {
  if (loading) {
    return (
      <div
        aria-live="polite"
        data-testid="maps-loading"
        style={{ ...GLASS_PANEL_STYLE, padding: 18 }}
      >
        <p style={{ ...SECONDARY_TEXT_STYLE }}>Loading maps…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" data-testid="maps-error" style={ERROR_PANEL_STYLE}>
        {error}
      </div>
    );
  }
  if (empty) {
    return (
      <div
        data-testid="maps-empty"
        style={{ ...GLASS_PANEL_STYLE, padding: 18 }}
      >
        <p style={{ margin: 0, fontWeight: 650 }}>{emptyTitle}</p>
        <p style={{ ...SECONDARY_TEXT_STYLE, marginTop: 6 }}>{emptyBody}</p>
      </div>
    );
  }
  return null;
}
