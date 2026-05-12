import type * as React from "react";

import { SidebarContent } from "../sidebar";

export interface SkillSidebarItemProps {
  active?: boolean;
  attentionLabel?: React.ReactNode;
  description?: React.ReactNode;
  enabled: boolean;
  icon?: React.ReactNode;
  name: React.ReactNode;
  offLabel: React.ReactNode;
  onLabel: React.ReactNode;
  onSelect?: () => void;
  testId?: string;
  buttonProps?: Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "onClick" | "type"
  >;
}

export function SkillSidebarItem({
  active = false,
  attentionLabel,
  description,
  enabled,
  icon,
  name,
  offLabel,
  onLabel,
  onSelect,
  testId,
  buttonProps,
}: SkillSidebarItemProps) {
  return (
    <SidebarContent.Item
      as="div"
      active={active}
      data-testid={testId}
      className="items-start gap-2"
    >
      <SidebarContent.ItemButton
        role="option"
        aria-selected={active}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        {...buttonProps}
      >
        <SidebarContent.ItemIcon active={active}>
          {icon}
        </SidebarContent.ItemIcon>
        <SidebarContent.ItemBody>
          <SidebarContent.ItemTitle>{name}</SidebarContent.ItemTitle>
          {description ? (
            <SidebarContent.ItemDescription>
              {description}
            </SidebarContent.ItemDescription>
          ) : null}
        </SidebarContent.ItemBody>
      </SidebarContent.ItemButton>
      <div className="flex shrink-0 flex-col items-end gap-2">
        <span
          className={`rounded-full border px-2.5 py-1 text-2xs font-bold tracking-[0.16em] ${
            enabled
              ? "border-accent bg-accent text-accent-fg"
              : "border-border bg-transparent text-muted"
          }`}
        >
          {enabled ? onLabel : offLabel}
        </span>
        {attentionLabel ? (
          <span className="rounded-full border border-warn/30 bg-warn/12 px-2 py-0.5 text-3xs font-bold uppercase tracking-[0.14em] text-warn">
            {attentionLabel}
          </span>
        ) : null}
      </div>
    </SidebarContent.Item>
  );
}
