/** One full-width grouped row in the trajectory history list. */
import { ChevronRight } from "lucide-react";
import type * as React from "react";

import { StatusDot } from "../../ui/status-badge";
import { SidebarContent } from "../sidebar";

function InlineMeta({
  color,
  label,
}: {
  color?: string;
  label: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-[color:var(--settings-muted)]">
      {color ? <StatusDot size="compact" color={color} /> : null}
      <span>{label}</span>
    </span>
  );
}

export interface TrajectorySidebarItemProps {
  active?: boolean;
  callCount: React.ReactNode;
  durationLabel: React.ReactNode;
  onSelect?: () => void;
  sourceColor?: string;
  sourceLabel: React.ReactNode;
  statusColor?: string;
  statusLabel: React.ReactNode;
  title: React.ReactNode;
  tokenLabel: React.ReactNode;
}

export function TrajectorySidebarItem({
  active = false,
  callCount,
  durationLabel,
  onSelect,
  sourceColor,
  sourceLabel,
  statusColor,
  statusLabel,
  title,
  tokenLabel,
}: TrajectorySidebarItemProps) {
  return (
    <SidebarContent.Item
      active={active}
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className="min-h-[68px] px-4 py-3"
    >
      <SidebarContent.ItemBody>
        <SidebarContent.ItemTitle className="font-medium">
          {title}
        </SidebarContent.ItemTitle>
        <SidebarContent.ItemDescription className="text-[color:var(--settings-muted)]">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <InlineMeta label={sourceLabel} color={sourceColor} />
            <span>{tokenLabel}</span>
            <span>{durationLabel}</span>
          </span>
        </SidebarContent.ItemDescription>
      </SidebarContent.ItemBody>
      <span className="flex shrink-0 items-center gap-2 self-center text-xs text-[color:var(--settings-muted)]">
        <span className="hidden min-[360px]:inline">{callCount} calls</span>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot size="compact" color={statusColor} />
          <span className="sr-only">{statusLabel}</span>
        </span>
        <ChevronRight className="size-4" aria-hidden />
      </span>
    </SidebarContent.Item>
  );
}
