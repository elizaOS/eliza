import type * as React from "react";

import { SidebarContent } from "../sidebar";

function InlineMeta({
  color,
  label,
}: {
  color?: string;
  label: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-2xs font-medium text-muted/85">
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={color ? { backgroundColor: color } : undefined}
      />
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
    >
      <SidebarContent.ItemIcon
        active={active}
        className="text-xs-tight font-bold"
      >
        {callCount}
      </SidebarContent.ItemIcon>
      <SidebarContent.ItemBody>
        <SidebarContent.ItemTitle>{title}</SidebarContent.ItemTitle>
        <SidebarContent.ItemDescription>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <InlineMeta label={sourceLabel} color={sourceColor} />
            <InlineMeta label={statusLabel} color={statusColor} />
            <span>{tokenLabel}</span>
            <span>{durationLabel}</span>
          </span>
        </SidebarContent.ItemDescription>
      </SidebarContent.ItemBody>
    </SidebarContent.Item>
  );
}
