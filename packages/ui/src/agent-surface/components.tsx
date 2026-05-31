/**
 * Agent-aware UI primitives. Thin wrappers that register themselves with the
 * view's agent surface so the agent can target them, while rendering like any
 * other element. Views can also use `useAgentElement` directly on bespoke
 * markup — these cover the common control + tag cases.
 */

import type {
  ButtonHTMLAttributes,
  ComponentType,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "../lib/utils";
import type { AgentElementRole } from "./types";
import { useAgentElement } from "./useAgentElement";

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean;
}>;

export interface AgentButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Stable agent id, unique within the view. */
  agentId: string;
  /** Label the agent uses to target this button (defaults to text children). */
  agentLabel?: string;
  agentRole?: Extract<AgentElementRole, "button" | "toggle" | "tab" | "link">;
  /** Status token rendered as `data-state` (e.g. "active", "loading"). */
  agentStatus?: string;
  agentGroup?: string;
  agentDescription?: string;
}

export function AgentButton({
  agentId,
  agentLabel,
  agentRole = "button",
  agentStatus,
  agentGroup,
  agentDescription,
  children,
  ...rest
}: AgentButtonProps) {
  const label =
    agentLabel ?? (typeof children === "string" ? children : agentId);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: agentRole,
    label,
    status: agentStatus,
    group: agentGroup,
    description: agentDescription,
  });
  return (
    <button ref={ref} type="button" {...agentProps} {...rest}>
      {children}
    </button>
  );
}

export interface AgentInputProps extends InputHTMLAttributes<HTMLInputElement> {
  agentId: string;
  agentLabel: string;
  agentRole?: Extract<AgentElementRole, "text-input" | "number-input">;
  agentStatus?: string;
  agentGroup?: string;
  agentDescription?: string;
}

export function AgentInput({
  agentId,
  agentLabel,
  agentRole = "text-input",
  agentStatus,
  agentGroup,
  agentDescription,
  ...rest
}: AgentInputProps) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: agentId,
    role: agentRole,
    label: agentLabel,
    status: agentStatus,
    group: agentGroup,
    description: agentDescription,
  });
  return <input ref={ref} aria-label={agentLabel} {...agentProps} {...rest} />;
}

const TONE_CLASSES: Record<string, string> = {
  neutral: "bg-bg-muted text-text border-border",
  accent: "bg-accent-subtle text-accent border-accent-muted",
  success: "bg-status-success/15 text-status-success border-status-success/30",
  warning: "bg-status-warning/15 text-status-warning border-status-warning/30",
  danger: "bg-status-danger/15 text-status-danger border-status-danger/30",
};

export interface IconTagProps {
  /** Lucide (or any) icon component to render as the graphic. */
  icon?: IconComponent;
  label: ReactNode;
  tone?: keyof typeof TONE_CLASSES;
  /** Rendered as `data-state` and `data-status` so it counts as an indicator. */
  status?: string;
  className?: string;
  title?: string;
}

/**
 * IconTag — a compact, graphic-first chip (icon + label) used to replace bare
 * text tags. The rounded-full pill + `data-status` make it register as a visual
 * indicator in the view audit.
 */
export function IconTag({
  icon: Icon,
  label,
  tone = "neutral",
  status,
  className,
  title,
}: IconTagProps) {
  return (
    <span
      data-status={status ?? tone}
      data-state={status ?? tone}
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
      {label}
    </span>
  );
}
