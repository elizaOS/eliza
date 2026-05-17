import type { ComponentType, MouseEvent, ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/utils";
import { BrandButton } from "../brand";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../dropdown-menu";

type ListActionMenuItem =
  | {
      type?: "item";
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
        <BrandButton
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8 shrink-0", triggerClassName)}
          onClick={onTriggerClick}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Open actions</span>
        </BrandButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className={cn("w-44", contentClassName)}>
        {label ? <DropdownMenuLabel>{label}</DropdownMenuLabel> : null}
        {label ? <DropdownMenuSeparator /> : null}
        {items.map((item, index) => {
          if (item.type === "separator") {
            return <DropdownMenuSeparator key={`separator-${index}`} />;
          }

          const Icon = item.icon;
          const className = cn(
            item.destructive && "text-destructive focus:text-destructive",
            item.className,
          );

          if (item.asChild) {
            return (
              <DropdownMenuItem
                key={`item-${index}`}
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
              key={`item-${index}`}
              className={className}
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              {Icon ? <Icon className="mr-2 h-4 w-4" /> : null}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type { ListActionMenuItem, ListActionMenuProps };
