/**
 * Per-row overflow action menu (dropdown) for dashboard list items.
 */
import { MoreHorizontal } from "lucide-react";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import { Button } from "../../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { cn } from "../../lib/utils";

type ListActionMenuItem =
  | {
      type?: "item";
      key?: string;
      label: ReactNode;
      icon?: ComponentType<{ className?: string }>;
      onSelect?: () => void;
      disabled?: boolean;
      destructive?: boolean;
      className?: string;
      asChild?: false;
    }
  | {
      type?: "item";
      key?: string;
      label: ReactNode;
      icon?: ComponentType<{ className?: string }>;
      disabled?: boolean;
      destructive?: boolean;
      className?: string;
      asChild: true;
      child: ReactNode;
    }
  | {
      type: "separator";
      key?: string;
    };

interface ListActionMenuProps {
  label?: ReactNode;
  items: readonly ListActionMenuItem[];
  align?: "start" | "center" | "end";
  contentClassName?: string;
  triggerClassName?: string;
  onTriggerClick?: (event: MouseEvent) => void;
}

export function ListActionMenu({
  label,
  items,
  align = "end",
  contentClassName,
  triggerClassName,
  onTriggerClick,
}: ListActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8 shrink-0", triggerClassName)}
          onClick={onTriggerClick}
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Open actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn("w-44", contentClassName)}
      >
        {label ? <DropdownMenuLabel>{label}</DropdownMenuLabel> : null}
        {label ? <DropdownMenuSeparator /> : null}
        {items.map((item) => {
          if (item.type === "separator") {
            return <DropdownMenuSeparator key={item.key ?? "separator"} />;
          }

          const Icon = item.icon;
          const className = cn(
            item.destructive && "text-destructive ",
            item.className,
          );

          if (item.asChild) {
            return (
              <DropdownMenuItem
                key={item.key ?? String(item.label)}
                asChild
                className={className}
                disabled={item.disabled}
              >
                {item.child}
              </DropdownMenuItem>
            );
          }

          return (
            <DropdownMenuItem
              key={item.key ?? String(item.label)}
              className={className}
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              {Icon ? <Icon className="mr-2  size-4" /> : null}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type { ListActionMenuItem, ListActionMenuProps };
