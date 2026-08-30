/**
 * Provides the self-contained layout, state, and agent-aware controls used by
 * the statically packaged Notes renderer.
 */

import { Button, type ButtonProps } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import type { CSSProperties } from "react";
import type { StickyColor } from "../types.js";

export const PANEL_STYLE: CSSProperties = {
  boxSizing: "border-box",
  border: "1px solid var(--border, rgba(255,255,255,.12))",
  borderRadius: "var(--radius-xl, 16px)",
  background:
    "color-mix(in srgb, var(--card, #121212) 96%, var(--surface, rgba(255,255,255,.04)) 4%)",
};

export const SECONDARY_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--muted, rgba(255,255,255,.62))",
  fontSize: 13,
  lineHeight: 1.45,
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
}: Omit<ButtonProps, "variant" | "size"> & {
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
  return (
    <Button
      ref={control.ref}
      type="button"
      variant={
        variant === "primary"
          ? "default"
          : variant === "quiet"
            ? "ghost"
            : "surface"
      }
      size={compact ? "icon-lg" : "touch"}
      {...control.agentProps}
      {...rest}
      aria-label={rest["aria-label"] ?? (compact ? agentLabel : undefined)}
      disabled={disabled}
      onClick={onClick}
      style={style}
    >
      {children}
    </Button>
  );
}

export const COLOR_MATERIALS: Record<StickyColor, string> = {
  yellow: "rgba(234, 179, 8, .08)",
  green: "rgba(34, 197, 94, .07)",
  rose: "rgba(244, 63, 94, .07)",
  slate: "rgba(148, 148, 148, .06)",
};
