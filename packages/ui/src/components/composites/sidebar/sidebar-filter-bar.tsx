import { ArrowDown, ArrowUp, RefreshCw } from "lucide-react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import type { SidebarFilterBarProps } from "./sidebar-types";

const sidebarFilterBarClassName = "flex w-full min-w-0 items-center gap-2";

const sidebarFilterPrimaryClassName = "min-w-0 flex-1";

const sidebarFilterActionsClassName = "flex shrink-0 items-center gap-2";

const sidebarFilterButtonClassName =
  "h-10 w-10 shrink-0 rounded-sm border-border/60 bg-card/88 shadow-sm";

export function SidebarFilterBar({
  className,
  selectValue,
  selectOptions,
  onSelectValueChange,
  selectAriaLabel,
  selectTestId,
  sortDirection,
  onSortDirectionToggle,
  sortDirectionButtonTestId,
  sortAscendingLabel = "Sort ascending",
  sortDescendingLabel = "Sort descending",
  refreshButtonTestId,
  refreshLabel = "Refresh",
  onRefresh,
  ...props
}: SidebarFilterBarProps) {
  const currentSortDirectionLabel =
    sortDirection === "asc" ? sortAscendingLabel : sortDescendingLabel;

  return (
    <div
      data-sidebar-filter-bar
      className={cn(sidebarFilterBarClassName, className)}
      {...props}
    >
      <div className={sidebarFilterPrimaryClassName}>
        <Select value={selectValue} onValueChange={onSelectValueChange}>
          <SelectTrigger
            data-testid={selectTestId}
            aria-label={selectAriaLabel}
            className="h-10 min-w-0 flex-1 rounded-xl border border-border/60 bg-card/88 px-3 text-sm text-txt shadow-sm"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {selectOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <TooltipProvider delayDuration={200} skipDelayDuration={100}>
        <div className={sidebarFilterActionsClassName}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                data-testid={sortDirectionButtonTestId}
                className={sidebarFilterButtonClassName}
                aria-label={currentSortDirectionLabel}
                onClick={onSortDirectionToggle}
              >
                {sortDirection === "asc" ? (
                  <ArrowUp className="h-4 w-4" />
                ) : (
                  <ArrowDown className="h-4 w-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {currentSortDirectionLabel}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                data-testid={refreshButtonTestId}
                className={sidebarFilterButtonClassName}
                aria-label={refreshLabel}
                onClick={onRefresh}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {refreshLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  );
}
