/**
 * One skill row in a skills sidebar: icon, name/description, and an on/off state
 * badge with an optional attention pill. Built from the sidebar-content item
 * primitives so it matches other sidebar rows.
 */
import type * as React from "react";

import { ActionListRow } from "../../shared/ActionListRow";
import { StatusBadge } from "../../ui/status-badge";

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
  buttonRef?: React.Ref<HTMLButtonElement>;
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
  buttonRef,
}: SkillSidebarItemProps) {
  return (
    <ActionListRow
      element="button"
      buttonRef={buttonRef}
      selected={active}
      data-testid={testId}
      density="compact"
      alignment="start"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      leading={
        <span
          className={
            active
              ? "flex size-10 items-center justify-center rounded-sm bg-accent/18 p-2 text-txt-strong"
              : "flex size-10 items-center justify-center rounded-sm bg-bg-accent/80 p-2 text-muted"
          }
        >
          {icon}
        </span>
      }
      title={name}
      description={description}
      trailing={
        <span className="flex flex-col items-end gap-2">
          <StatusBadge
            label={enabled ? onLabel : offLabel}
            status={enabled ? "success" : "muted"}
          />
          {attentionLabel ? (
            <StatusBadge label={attentionLabel} status="warning" />
          ) : null}
        </span>
      }
      {...buttonProps}
    />
  );
}
