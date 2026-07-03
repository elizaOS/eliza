import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import * as React from "react";
import { Button } from "../ui/button";

export interface CollapsibleSidebarSectionProps {
  addLabel?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
  collapsed: boolean;
  emptyClassName?: string;
  emptyLabel?: string;
  hoverActionsOnDesktop?: boolean;
  icon?: React.ReactNode;
  indicator?: React.ReactNode;
  label: React.ReactNode;
  onAdd?: () => void;
  onToggleCollapsed: (key: string) => void;
  sectionKey: string;
  testIdPrefix?: string;
}

export function CollapsibleSidebarSection({
  addLabel,
  bodyClassName,
  children,
  collapsed,
  emptyClassName,
  emptyLabel,
  hoverActionsOnDesktop = true,
  icon,
  indicator,
  label,
  onAdd,
  onToggleCollapsed,
  sectionKey,
  testIdPrefix = "sidebar-section",
}: CollapsibleSidebarSectionProps): React.JSX.Element {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const hoverHideClass = hoverActionsOnDesktop
    ? " opacity-0 transition-opacity group-hover/section:opacity-100 "
    : "";
  const bodyId = `${testIdPrefix}-body-${sectionKey}`;
  const hasChildren = React.Children.count(children) > 0;

  return (
    <section
      data-testid={`${testIdPrefix}-${sectionKey}`}
      className="group/section space-y-0"
    >
      <div className="flex items-center gap-1 pr-1">
        <Button
          variant="ghost"
          onClick={() => onToggleCollapsed(sectionKey)}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          data-testid={`${testIdPrefix}-toggle-${sectionKey}`}
          className="h-auto min-w-0 flex-1 justify-start gap-1.5 rounded-sm bg-transparent px-1.5 py-1 text-left text-[11px] leading-none font-medium text-muted transition-colors hover:text-txt"
        >
          {icon ? (
            <span className="inline-flex shrink-0 items-center justify-center text-muted">
              {icon}
            </span>
          ) : null}
          <span className="truncate">{label}</span>
          {indicator ? (
            <span className="ml-0.5 inline-flex shrink-0 items-center">
              {indicator}
            </span>
          ) : null}
          <Chevron
            aria-hidden
            className={`ml-0.5 h-3 w-3 shrink-0 text-muted${hoverHideClass}`}
          />
        </Button>
        {onAdd ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onAdd}
            aria-label={addLabel ?? "Add"}
            title={addLabel}
            data-testid={`${testIdPrefix}-add-${sectionKey}`}
            className={`h-6 w-6 shrink-0 rounded-sm bg-transparent p-0 text-muted transition-colors hover:text-txt${hoverHideClass}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {collapsed ? null : hasChildren ? (
        <div id={bodyId} className={bodyClassName}>
          {children}
        </div>
      ) : emptyLabel ? (
        <div id={bodyId} className={emptyClassName}>
          {emptyLabel}
        </div>
      ) : null}
    </section>
  );
}
